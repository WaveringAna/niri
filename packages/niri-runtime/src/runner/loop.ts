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
import { archiveContextMessages } from "./context-store"
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
import { setLoopBudget } from "./loop-budget"
import { processToolCalls } from "./loop-tools"
import { discordSendPolicy } from "./policies"
import type { LoopHooks, LoopState } from "./types"

const LLM_RECENT_MIN_KEEP = 6
const LLM_RECENT_MAX_KEEP = 40
const LLM_TAIL_CHAR_BUDGET = 60_000
const IMPLICIT_WAIT_THEN_CONTINUE_MS = 10 * 60_000
const COMPACTION_PRUNE_PROTECTED_TAIL_CHARS = 40_000
const COMPACTION_PRUNE_MIN_TOOL_CHARS = 2_000
const COMPACTION_PRUNE_MIN_SAVINGS_CHARS = 8_000
const COMPACTION_PRUNE_EDGE_CHARS = 500
const COMPACTION_PRUNE_MARKER = "[tool output pruned during compaction;"

type CompactionPruneResult = {
  messages: Message[]
  prunedMessages: number
  removedChars: number
}

function toolCallNameMap(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const calls = (message as unknown as {
      tool_calls?: Array<{ id?: unknown; type?: unknown; function?: { name?: unknown } }>
    }).tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (
        call?.type === "function" &&
        typeof call.id === "string" &&
        typeof call.function?.name === "string"
      ) {
        names.set(call.id, call.function.name)
      }
    }
  }
  return names
}

function isPrunableToolOutput(toolName: string): boolean {
  if (!toolName) return false
  return !(
    toolName.startsWith("discord_") ||
    toolName.startsWith("memory_") ||
    toolName.startsWith("soul_") ||
    toolName.startsWith("context_") ||
    toolName === "schedule" ||
    toolName === "wait" ||
    toolName === "wait_then_continue" ||
    toolName === "rest" ||
    toolName === "delegate"
  )
}

function pruneToolOutputsForCompaction(messages: Message[]): CompactionPruneResult {
  let protectedStart = messages.length
  let protectedChars = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    protectedStart = index
    protectedChars += assistantContentText(messages[index]?.content).length
    if (protectedChars >= COMPACTION_PRUNE_PROTECTED_TAIL_CHARS) break
  }

  const toolNames = toolCallNameMap(messages)
  let prunedMessages = 0
  let removedChars = 0
  const pruned = messages.map((message, index) => {
    if (index >= protectedStart || message.role !== "tool" || typeof message.content !== "string") return message
    const content = message.content
    if (content.length < COMPACTION_PRUNE_MIN_TOOL_CHARS || content.startsWith(COMPACTION_PRUNE_MARKER)) return message
    const toolCallId = (message as unknown as { tool_call_id?: unknown }).tool_call_id
    const toolName = typeof toolCallId === "string" ? (toolNames.get(toolCallId) ?? "") : ""
    if (!isPrunableToolOutput(toolName)) return message

    const replacement =
      `${COMPACTION_PRUNE_MARKER} ${content.length} chars archived; tool=${toolName}. ` +
      "search the context archive with context_grep and a distinctive retained snippet to recover exact output]\n" +
      `${content.slice(0, COMPACTION_PRUNE_EDGE_CHARS)}\n...\n${content.slice(-COMPACTION_PRUNE_EDGE_CHARS)}`
    if (replacement.length >= content.length) return message
    prunedMessages++
    removedChars += content.length - replacement.length
    return { ...message, content: replacement } as Message
  })

  if (removedChars < COMPACTION_PRUNE_MIN_SAVINGS_CHARS) {
    return { messages, prunedMessages: 0, removedChars: 0 }
  }
  return { messages: pruned, prunedMessages, removedChars }
}

enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Rest = "rest",
}

export type RunLoopExit = "rest"

async function waitForImplicitContinuation(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
): Promise<void> {
  console.log(`[runner] no wait tool selected; inferring wait_then_continue(${IMPLICIT_WAIT_THEN_CONTINUE_MS})`)
  const incoming = await hooks.waitForEventWithTimeout(IMPLICIT_WAIT_THEN_CONTINUE_MS)
  if (incoming) {
    hooks.injectIncomingEvent(convId, incoming)
    return
  }
  if (hooks.shouldShutdown()) return
  const continuation =
    `[system] the inferred ten-minute wait elapsed with no incoming event. continue if useful, or answer without a tool again to wait another ten minutes.`
  state.conversation.push({ role: "user", content: continuation })
  emit({ type: "text", text: continuation })
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
  setLoopBudget({ tokenCount: state.tokenCount, contextSize: state.contextSize })

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

async function applyLLMCompaction(
  convId: number,
  state: LoopState,
  phase: "pre-turn" | "post-turn",
): Promise<boolean> {
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  if (state.contextSize < CONTEXT_COMPACT_TRIGGER_TOKENS) return false

  let mechanicallyPruned = false
  const pruneResult = pruneToolOutputsForCompaction(state.conversation)
  if (pruneResult.prunedMessages > 0) {
    const beforePrune = estimatePromptTokens(state.conversation)
    archiveContextMessages(state.conversation, `${phase}-tool-prune`)
    state.conversation = pruneResult.messages
    state.contextSize = estimatePromptTokens(state.conversation)
    setLoopBudget({ contextSize: state.contextSize })
    mechanicallyPruned = true
    console.log(
      `[context agent=${AGENT_ID}] ${phase}: pruned ${pruneResult.prunedMessages} archived tool output(s) during compaction (${beforePrune} -> ${state.contextSize} tokens, removed=${pruneResult.removedChars} chars)`,
    )
    recordMetric({
      type: "compaction",
      before: beforePrune,
      after: state.contextSize,
      method: `${phase}-tool-prune`,
    })
    if (state.contextSize < CONTEXT_COMPACT_TRIGGER_TOKENS) return true
  }

  const summaryProvider = await configuredSummaryProvider()
  if (!summaryProvider.client || !summaryProvider.model) {
    console.warn(`[context agent=${AGENT_ID}] ${phase}: no summary client available; skipping llm compaction`)
    return mechanicallyPruned
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
    return mechanicallyPruned
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
      setLoopBudget({ contextSize: state.contextSize })
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
    return mechanicallyPruned
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
    return mechanicallyPruned
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
  setLoopBudget({ contextSize: state.contextSize })

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
  setLoopBudget({ tokenCount: state.tokenCount, contextSize: state.contextSize })

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
    const turnMessages = state.conversation.slice(turnStart)

    // Nudge when the assistant produces conversational text in response to
    // a Discord message but forgets to call discord_send. This is a common
    // hallucination pattern — the model writes a reply "in its head" and
    // then calls wait/rest, leaving the Discord user in silence.
    let discordSendNudged = false
    if (outcome !== CycleOutcome.Rest) {
      const nudge = discordSendPolicy.onTurnEnd?.({
        convId, state: state as never, runtime: undefined as never, turnMessages, calledTools: outcome === CycleOutcome.ToolsDone,
      })
      if (typeof nudge === "string" && nudge) {
        state.conversation.push({ role: "user", content: nudge })
        discordSendNudged = true
      }
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
      await waitForImplicitContinuation(convId, state, hooks)
      if (hooks.shouldShutdown()) {
        await hooks.saveShutdownSnapshot()
        hooks.resolveShutdown()
        return "rest"
      }
      continue
    }

    await applyLLMCompaction(convId, state, "post-turn")
    await hooks.saveSession()
  }
}

export const __loopTest = {
  waitForImplicitContinuation,
  pruneToolOutputsForCompaction,
  shouldDeferSmallFollowUpCompaction,
}
