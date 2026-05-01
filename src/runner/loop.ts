import type OpenAI from "openai"
import { recordMetric } from "../metrics.js"
import { emit } from "../stream.js"
import {
  CONTEXT_COMPACT_TRIGGER_TOKENS,
  ENABLE_THINKING,
  FALLBACK_TOKEN_NUDGE_THRESHOLD,
  TOKEN_NUDGE_THRESHOLD,
  USE_FALLBACK,
  estimatePromptTokens,
  findSummaryMessageIndex,
  summarizeConversationViaLLM,
} from "./util.js"
import { addAssistantMessage, applyUsage, configuredSummaryProvider, emitThinking, fetchCompletion } from "./loop-completion.js"
import { assistantContentText, isFunctionToolCall } from "./loop-content.js"
import { buildTurnSignature, hasIncomingUserMessage } from "./loop-signatures.js"
import { processToolCalls } from "./loop-tools.js"
import type { LoopHooks, LoopState } from "./types.js"

const LLM_POST_TURN_RECENT_MESSAGES = 40
const RUNNER_MAX_TURNS = parsePositiveIntEnv(process.env.RUNNER_MAX_TURNS, 120)
const RUNNER_MAX_IDENTICAL_TOOL_TURNS = parsePositiveIntEnv(process.env.RUNNER_MAX_IDENTICAL_TOOL_TURNS, 10)

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Rest = "rest",
}

export type RunLoopExit = "rest" | "guard_stop"

async function waitForNextEvent(convId: number, hooks: LoopHooks): Promise<void> {
  const incoming = await hooks.waitForEvent()
  hooks.injectIncomingEvent(convId, incoming)
}

async function stopLoopForGuard(state: LoopState, hooks: LoopHooks, reason: string): Promise<RunLoopExit> {
  const guardMessage = `[system] safety stop: ${reason}. pausing until a new external event wakes niri again.`
  console.warn(`[runner] ${reason}`)
  state.conversation.push({
    role: "user",
    content: guardMessage,
  })
  emit({ type: "text", text: guardMessage })
  await hooks.saveSession()
  return "guard_stop"
}

async function processAssistantTurn(convId: number, state: LoopState, hooks: LoopHooks): Promise<CycleOutcome> {
  state.memoryRecallTurn += 1
  const response = await fetchCompletion(state)
  applyUsage(state, response.usage)

  const msg = response.message
  addAssistantMessage(convId, state, msg)

  if (ENABLE_THINKING) {
    if (!response.emittedThinking && response.bufferedThinking) {
      emit({ type: "thinking", text: response.bufferedThinking })
    } else if (!response.emittedThinking) {
      emitThinking(msg)
    }
  }

  const functionCalls = (msg.tool_calls ?? []).filter(isFunctionToolCall)
  if (!response.emittedText && msg.content) emit({ type: "text", text: msg.content })
  if (functionCalls.length === 0) return CycleOutcome.NoTools

  const shouldRest = await processToolCalls(convId, state, hooks, functionCalls)
  return shouldRest ? CycleOutcome.Rest : CycleOutcome.ToolsDone
}

/**
 * Detects when the assistant responded to a Discord message with
 * conversational text but did not call discord_send. Injects a system
 * nudge so the next turn actually delivers the message.
 */
function isDiscordInputMessage(message: OpenAI.Chat.ChatCompletionMessage | OpenAI.Chat.ChatCompletionMessageParam): boolean {
  return message.role === "user" && typeof message.content === "string" && /\[discord\/(?:dm|batch|channel)\]/i.test(message.content)
}

function hasDiscordInputForTurn(
  conversation: OpenAI.Chat.ChatCompletionMessageParam[],
  turnMessages: OpenAI.Chat.ChatCompletionMessage[],
  turnStart: number,
): boolean {
  if (turnMessages.some(isDiscordInputMessage)) return true

  // After a harness restart, the triggering Discord event is appended before
  // the first post-restart assistant turn. Look backward to the latest
  // assistant boundary and treat intervening user messages as active context.
  for (let i = turnStart - 1; i >= 0; i--) {
    const message = conversation[i]
    if (!message) continue
    if (message.role === "assistant") break
    if (isDiscordInputMessage(message)) return true
  }

  return false
}

function applyDiscordSendNudge(
  state: LoopState,
  turnMessages: OpenAI.Chat.ChatCompletionMessage[],
  turnStart: number,
): boolean {
  // Check if the assistant is responding to active Discord input, including
  // the post-restart case where the triggering user message is already in the
  // conversation before the turn begins.
  const hasDiscordInput = hasDiscordInputForTurn(state.conversation, turnMessages, turnStart)
  if (!hasDiscordInput) return false

  // Check if the assistant called discord_send in this turn
  const hasDiscordSend = turnMessages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === "function" && tc.function.name === "discord_send"),
  )
  if (hasDiscordSend) return false

  // Also check if a tool result from discord_send exists (edge case: tool result is separate message)
  const hasDiscordSendResult = turnMessages.some(
    (m) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.includes('"ok":true') &&
      m.content.includes("discord_send"),
  )
  if (hasDiscordSendResult) return false

  // Find the assistant's text content in this turn
  const assistantText = turnMessages.find((m) => m.role === "assistant" && assistantContentText(m.content).length > 0)
  if (!assistantText) return false

  // The assistant wrote something in response to a Discord message but
  // never actually sent it. Nudge.
  const nudge = `[system] you wrote a response to a Discord message but did not call discord_send. your message was not delivered. call discord_send now or explicitly decide not to reply.`
  console.warn("[runner] discord_send nudge: assistant responded to Discord input without calling discord_send")
  state.conversation.push({ role: "user", content: nudge })
  return true
}

function applyContextNudge(state: LoopState): void {
  const tokenNudgeThreshold = USE_FALLBACK ? FALLBACK_TOKEN_NUDGE_THRESHOLD : TOKEN_NUDGE_THRESHOLD
  const contextProvider = USE_FALLBACK ? "fallback" : "primary"

  if (state.contextSize >= tokenNudgeThreshold) {
    state.conversation.push({
      role: "user",
      content: `[system] context at ~${Math.round(state.contextSize / 1000)}k tokens (${contextProvider}). Consider wrapping up soon to stay within the context limit.`,
    })
  }
}

async function applyLLMCompaction(state: LoopState, phase: "pre-turn" | "post-turn"): Promise<boolean> {
  const beforeEstimate = estimatePromptTokens(state.conversation)
  const contextPressure = Math.max(state.contextSize, beforeEstimate)
  if (contextPressure < CONTEXT_COMPACT_TRIGGER_TOKENS) return false

  const summaryProvider = configuredSummaryProvider()
  if (!summaryProvider.client || !summaryProvider.model) {
    console.warn(`[context] ${phase}: no summary client available; skipping llm compaction`)
    return false
  }

  const beforeCount = state.conversation.length
  const summarized = await summarizeConversationViaLLM(
    state.conversation,
    summaryProvider.client,
    summaryProvider.model,
    { recentKeep: LLM_POST_TURN_RECENT_MESSAGES },
  )
  if (!summarized) {
    console.warn(`[context] ${phase}: llm summary unavailable; keeping raw conversation`)
    return false
  }

  const afterEstimate = estimatePromptTokens(summarized)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context] ${phase}: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping raw conversation`)
    return false
  }

  state.conversation = summarized
  state.contextSize = afterEstimate

  const summaryIdx = findSummaryMessageIndex(state.conversation)
  const summary = summaryIdx >= 0 ? (state.conversation[summaryIdx]?.content as string) : undefined

  console.log(
    `[context] ${phase}: llm-summarized conversation via ${summaryProvider.model} (${beforeCount} -> ${summarized.length} msgs, ${beforeEstimate} -> ${afterEstimate} tokens)`,
  )

  recordMetric({
    type: "compaction",
    before: beforeEstimate,
    after: afterEstimate,
    method: `${phase}-llm`,
    summary,
  })
  return true
}

export async function runLoop(convId: number, state: LoopState, hooks: LoopHooks): Promise<RunLoopExit> {
  let turnCount = 0
  let previousTurnSignature: string | null = null
  let consecutiveIdenticalToolTurns = 0

  while (true) {
    const preCompacted = await applyLLMCompaction(state, "pre-turn")
    if (preCompacted) await hooks.saveSession()

    const turnStart = state.conversation.length
    const outcome = await processAssistantTurn(convId, state, hooks)
    turnCount += 1

    const turnMessages = state.conversation.slice(turnStart)
    const interruptedByUserEvent = hasIncomingUserMessage(turnMessages)
    const turnSignature = buildTurnSignature(turnMessages)

    // Nudge when the assistant produces conversational text in response to
    // a Discord message but forgets to call discord_send. This is a common
    // hallucination pattern — the model writes a reply "in its head" and
    // then calls wait/rest, leaving the Discord user in silence.
    let discordSendNudged = false
    if (outcome !== CycleOutcome.Rest) {
      discordSendNudged = applyDiscordSendNudge(state, turnMessages, turnStart)
    }

    if (interruptedByUserEvent || !turnSignature) {
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
    } else if (turnSignature === previousTurnSignature) {
      consecutiveIdenticalToolTurns += 1
    } else {
      previousTurnSignature = turnSignature
      consecutiveIdenticalToolTurns = 1
    }

    if (outcome === CycleOutcome.Rest) return "rest"
    if (outcome === CycleOutcome.NoTools) {
      if (discordSendNudged) continue
      await hooks.saveSession()
      await waitForNextEvent(convId, hooks)
      continue
    }

    if (turnCount >= RUNNER_MAX_TURNS) {
      return stopLoopForGuard(state, hooks, `loop guard tripped after ${turnCount} turns`)
    }

    if (consecutiveIdenticalToolTurns >= RUNNER_MAX_IDENTICAL_TOOL_TURNS && previousTurnSignature) {
      return stopLoopForGuard(
        state,
        hooks,
        `loop guard tripped after ${consecutiveIdenticalToolTurns} identical assistant/tool turns`,
      )
    }

    await applyLLMCompaction(state, "post-turn")
    applyContextNudge(state)
    await hooks.saveSession()
  }
}

export const __loopTest = {
  applyDiscordSendNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
}
