import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { Message } from "../types"
import { AGENT_ID } from "../agent-config"
import {
  CONTEXT_COMPACT_HARD_TRIGGER_TOKENS,
  CONTEXT_COMPACT_MIN_NEW_MESSAGES,
  CONTEXT_COMPACT_TRIGGER_TOKENS,
  COMPACTION_RECOLLECTION_PROMPT,
  ENABLE_THINKING,
  countConversationCompactionCandidates,
  estimatePromptTokens,
  findSummaryMessageIndex,
  loadAgentSummaryContext,
  summarizeConversationViaLLMWithProvenance,
} from "./util"
import { canConsolidateLcmFrontier, commitLcmCompaction, consolidateLcmFrontier } from "./lcm-compaction"
import {
  addAssistantMessage,
  applyUsage,
  collectAgentCompactionRecollection,
  configuredSummaryProvider,
  emitThinking,
  fetchCompletion,
} from "./loop-completion"
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
  const response = await fetchCompletion(convId, state, undefined, hooks.getTools())
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

function activeUserTurnMessages(conversation: Message[], turnMessages: Message[]): Message[] {
  // Prefer a user event injected during this model/tool step. Otherwise walk
  // back to the latest user message in the full conversation. This keeps the
  // original input active across preliminary assistant/tool steps such as
  // memory_read on a fresh wake.
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    if (turnMessages[i]?.role === "user") return turnMessages.slice(i)
  }
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]?.role === "user") return conversation.slice(i)
  }
  return turnMessages
}

function hasDiscordInputForTurn(conversation: Message[], turnMessages: Message[]): boolean {
  return activeUserTurnMessages(conversation, turnMessages).some(isDiscordInputMessage)
}

function applyDiscordSendNudge(
  state: LoopState,
  turnMessages: Message[],
): boolean {
  // Check the whole active user turn, including preliminary tool calls made
  // after a fresh wake and before the assistant writes its reply.
  const activeTurnMessages = activeUserTurnMessages(state.conversation, turnMessages)
  const hasDiscordInput = activeTurnMessages.some(isDiscordInputMessage)
  if (!hasDiscordInput) return false

  // A discord_send from an earlier assistant/tool step in the same user turn
  // means the reply was already delivered.
  const hasDiscordSend = activeTurnMessages.some(
    (m) =>
      m.role === "assistant" &&
      "tool_calls" in m &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === "function" && tc.function.name === "discord_send"),
  )
  if (hasDiscordSend) return false

  // Also check if a tool result from discord_send exists (edge case: tool result is separate message)
  const hasDiscordSendResult = activeTurnMessages.some(
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

async function applyLLMCompaction(
  convId: number,
  state: LoopState,
  phase: "pre-turn" | "post-turn",
): Promise<boolean> {
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  if (state.contextSize < CONTEXT_COMPACT_TRIGGER_TOKENS) return false

  const summaryProvider = await configuredSummaryProvider()
  if (!summaryProvider.client || !summaryProvider.model) {
    console.warn(`[context agent=${AGENT_ID}] ${phase}: no summary client available; skipping llm compaction`)
    return false
  }

  const priorSummaryIndex = findSummaryMessageIndex(state.conversation)
  const candidateCount = countConversationCompactionCandidates(state.conversation, {
    recentMinKeep: LLM_RECENT_MIN_KEEP,
    recentMaxKeep: LLM_RECENT_MAX_KEEP,
    tailCharBudget: LLM_TAIL_CHAR_BUDGET,
  })
  const shouldDefer = shouldDeferSmallFollowUpCompaction(
    priorSummaryIndex >= 0,
    candidateCount,
    state.contextSize,
  )
  const canConsolidate = canConsolidateLcmFrontier(state.conversation)
  if (shouldDefer && !canConsolidate) {
    console.log(
      `[context agent=${AGENT_ID}] ${phase}: deferring follow-up compaction with only ${candidateCount} new candidate message(s) at ${state.contextSize} observed tokens (hard trigger ${CONTEXT_COMPACT_HARD_TRIGGER_TOKENS})`,
    )
    return false
  }

  const agentContext = await loadAgentSummaryContext()
  const beforeCount = state.conversation.length
  const beforeEstimate = estimatePromptTokens(state.conversation)
  let directRecollection: string | null = null
  if (canConsolidate) {
    directRecollection = await collectAgentCompactionRecollection(convId, state)
    const consolidated = await consolidateLcmFrontier(
      state.conversation,
      summaryProvider.client,
      summaryProvider.model,
      agentContext,
      false,
      directRecollection,
    )
    if (consolidated.mergedSummaryIds.length > 0) {
      state.conversation = consolidated.messages
      state.contextSize = estimatePromptTokens(state.conversation)
      console.log(
        `[context agent=${AGENT_ID}] ${phase}: reduced active lcm frontier before touching fresh tail (${beforeEstimate} -> ${state.contextSize} tokens, merged=${consolidated.mergedSummaryIds.join(",")}, active=${consolidated.activeSummaryIds.join(",")})`,
      )
      recordMetric({
        type: "compaction",
        before: beforeEstimate,
        after: state.contextSize,
        method: `${phase}-lcm-merge`,
      })
      return true
    }
  }

  if (shouldDefer) {
    console.log(
      `[context agent=${AGENT_ID}] ${phase}: deferring follow-up compaction with only ${candidateCount} new candidate message(s) at ${state.contextSize} observed tokens (hard trigger ${CONTEXT_COMPACT_HARD_TRIGGER_TOKENS})`,
    )
    return false
  }

  const preflightCompaction = await summarizeConversationViaLLMWithProvenance(
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
  if (!preflightCompaction) {
    console.warn(`[context agent=${AGENT_ID}] ${phase}: llm summary unavailable; keeping raw conversation`)
    return false
  }

  directRecollection ??= await collectAgentCompactionRecollection(convId, state)
  let compaction = preflightCompaction
  if (directRecollection) {
    const recollectedCompaction = await summarizeConversationViaLLMWithProvenance(
      state.conversation,
      summaryProvider.client,
      summaryProvider.model,
      {
        recentMinKeep: LLM_RECENT_MIN_KEEP,
        recentMaxKeep: LLM_RECENT_MAX_KEEP,
        tailCharBudget: LLM_TAIL_CHAR_BUDGET,
        agentContext,
        directRecollection,
      },
    )
    if (recollectedCompaction) {
      compaction = recollectedCompaction
    } else {
      console.warn(
        `[context agent=${AGENT_ID}] ${phase}: testimony weave unavailable; using viable preflight summary and preserving exact testimony in provenance`,
      )
      compaction = {
        ...preflightCompaction,
        compactedMessages: [
          ...preflightCompaction.compactedMessages,
          { role: "user", content: COMPACTION_RECOLLECTION_PROMPT },
          { role: "assistant", content: directRecollection },
        ],
      }
    }
  }

  const afterEstimate = estimatePromptTokens(compaction.messages)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context agent=${AGENT_ID}] ${phase}: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping raw conversation`)
    return false
  }

  const committed = await commitLcmCompaction(
    compaction,
    summaryProvider.client,
    summaryProvider.model,
    `${phase}-llm`,
    agentContext,
  )
  state.conversation = committed.messages
  state.contextSize = estimatePromptTokens(state.conversation)

  console.log(
    `[context agent=${AGENT_ID}] ${phase}: added lcm segment via ${summaryProvider.model} (${beforeCount} -> ${state.conversation.length} msgs, ${beforeEstimate} -> ${state.contextSize} tokens, leaf=${committed.leafSummaryId}, active=${committed.activeSummaryIds.join(",")})`,
  )

  recordMetric({
    type: "compaction",
    before: beforeEstimate,
    after: state.contextSize,
    method: `${phase}-llm`,
    summary: compaction.summaryContent,
  })
  return true
}

function shouldDeferSmallFollowUpCompaction(
  hasPriorSummary: boolean,
  candidateCount: number,
  observedPromptTokens: number,
): boolean {
  return (
    hasPriorSummary &&
    candidateCount < CONTEXT_COMPACT_MIN_NEW_MESSAGES &&
    observedPromptTokens < CONTEXT_COMPACT_HARD_TRIGGER_TOKENS
  )
}

export async function runLoop(convId: number, state: LoopState, hooks: LoopHooks): Promise<RunLoopExit> {
  let turnCount = 0
  let previousTurnSignature: string | null = null
  let consecutiveIdenticalToolTurns = 0

  while (true) {
    const preCompacted = await applyLLMCompaction(convId, state, "pre-turn")
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
      discordSendNudged = applyDiscordSendNudge(state, turnMessages)
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

    await applyLLMCompaction(convId, state, "post-turn")
    await hooks.saveSession()
  }
}

export const __loopTest = {
  applyLoopGuardNudge,
  applyDiscordSendNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
  shouldDeferSmallFollowUpCompaction,
}
