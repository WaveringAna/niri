import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { Message } from "../types"
import {
  CONTEXT_COMPACT_TRIGGER_TOKENS,
  ENABLE_THINKING,
  estimatePromptTokens,
  findSummaryMessageIndex,
  loadAgentSummaryContext,
  summarizeConversationViaLLM,
} from "./util"
import { addAssistantMessage, applyUsage, configuredSummaryProvider, emitThinking, fetchCompletion } from "./loop-completion"
import { assistantContentText, isFunctionToolCall } from "./loop-content"
import { buildTurnSignature, hasIncomingUserMessage } from "./loop-signatures"
import { processToolCalls } from "./loop-tools"
import type { LoopHooks, LoopState } from "./types"

const LLM_RECENT_MIN_KEEP = 6
const LLM_RECENT_MAX_KEEP = 40
const LLM_TAIL_CHAR_BUDGET = 60_000
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

export type RunLoopExit = "rest"

async function waitForNextEvent(convId: number, hooks: LoopHooks): Promise<boolean> {
  const incoming = await hooks.waitForEvent()
  if (!incoming) return false
  hooks.injectIncomingEvent(convId, incoming)
  return true
}

async function applyLoopGuardNudge(state: LoopState, hooks: LoopHooks, reason: string): Promise<void> {
  const guardMessage =
    `[system] hey, you've been going for a while (${reason}). this is just a heads-up in case you're stuck and need help — most likely you're fine and don't need to do anything different, especially if you're actively doing something, in conversation with people, or things are happening RIGHT NOW. just keep going. resting is only a suggestion for if nothing's actually happening and you're genuinely done; if you do rest, remember to tell your important people first.`
  console.warn(`[runner] ${reason}`)
  state.conversation.push({
    role: "user",
    content: guardMessage,
  })
  emit({ type: "text", text: guardMessage })
  await hooks.saveSession()
}

async function processAssistantTurn(convId: number, state: LoopState, hooks: LoopHooks): Promise<CycleOutcome> {
  state.memoryRecallTurn += 1
  const response = await fetchCompletion(state, undefined, hooks.getTools())
  // Recall (if any) has been applied for this turn; don't re-recall on the
  // follow-up iterations that work through the same incoming event.
  state.memoryRecallPending = false
  applyUsage(state, response.usage, {
    elapsedMs: response.elapsedMs,
    tokensPerSecond: response.tokensPerSecond,
  })

  const msg = response.message
  addAssistantMessage(convId, state, msg)

  if (ENABLE_THINKING) {
    // Thinking is now streamed live during completion, but handle edge cases
    // where reasoning exists without live emission (e.g. tag-parsed thinking).
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
function isDiscordInputMessage(message: Message): boolean {
  return message.role === "user" && typeof message.content === "string" && /\[discord(?:\/(?:dm|channel)| batch)\]/i.test(message.content)
}

function hasDiscordInputForTurn(
  conversation: Message[],
  turnMessages: Message[],
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
  turnMessages: Message[],
  turnStart = state.conversation.length,
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
      "tool_calls" in m &&
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

async function applyLLMCompaction(state: LoopState, phase: "pre-turn" | "post-turn"): Promise<boolean> {
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  if (state.contextSize < CONTEXT_COMPACT_TRIGGER_TOKENS) return false
  const beforeEstimate = estimatePromptTokens(state.conversation)

  const summaryProvider = await configuredSummaryProvider()
  if (!summaryProvider.client || !summaryProvider.model) {
    console.warn(`[context] ${phase}: no summary client available; skipping llm compaction`)
    return false
  }

  const beforeCount = state.conversation.length
  const agentContext = await loadAgentSummaryContext()
  const summarized = await summarizeConversationViaLLM(
    state.conversation,
    summaryProvider.client,
    summaryProvider.model,
    {
      recentMinKeep: LLM_RECENT_MIN_KEEP,
      recentMaxKeep: LLM_RECENT_MAX_KEEP,
      tailCharBudget: LLM_TAIL_CHAR_BUDGET,
      agentContext,
    },
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
    state.turnInFlight = true
    let outcome: CycleOutcome
    try {
      outcome = await processAssistantTurn(convId, state, hooks)
    } finally {
      state.turnInFlight = false
    }
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
    if (hooks.shouldShutdown()) {
      await hooks.saveShutdownSnapshot()
      hooks.resolveShutdown()
      return "rest"
    }
    if (outcome === CycleOutcome.NoTools) {
      if (discordSendNudged) continue
      await hooks.saveSession()
      const hasNextEvent = await waitForNextEvent(convId, hooks)
      if (!hasNextEvent && hooks.shouldShutdown()) {
        await hooks.saveShutdownSnapshot()
        hooks.resolveShutdown()
        return "rest"
      }
      continue
    }

    if (turnCount >= RUNNER_MAX_TURNS) {
      await applyLoopGuardNudge(state, hooks, `loop guard tripped after ${turnCount} turns`)
      turnCount = 0
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
      continue
    }

    if (consecutiveIdenticalToolTurns >= RUNNER_MAX_IDENTICAL_TOOL_TURNS && previousTurnSignature) {
      await applyLoopGuardNudge(
        state,
        hooks,
        `loop guard tripped after ${consecutiveIdenticalToolTurns} identical assistant/tool turns`,
      )
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
      continue
    }

    await applyLLMCompaction(state, "post-turn")
    await hooks.saveSession()
  }
}

export const __loopTest = {
  applyLoopGuardNudge,
  applyDiscordSendNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
}
