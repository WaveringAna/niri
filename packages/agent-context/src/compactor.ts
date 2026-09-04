import type {
  CompactionOutcome,
  ContextCompactor,
  LcmConfig,
  Message,
  PruneConfig,
  PruneResult,
  SummarizerModel,
  SummaryCircuit,
  SummaryGrounding,
  SummaryPrompts,
} from "./types.js"
import type { SqliteContextArchive } from "./sqlite-archive.js"
import type { LcmEngine } from "./lcm.js"
import {
  countConversationCompactionCandidates,
  estimatePromptTokens,
  findSummaryMessageIndex,
  summarizeConversationViaLLMWithProvenance,
} from "./summarize.js"

/**
 * Drives compaction for one agent.
 *
 * Ported from `applyLLMCompaction` in `@niri/runtime`'s `runner/loop.ts`, where
 * it was interleaved with loop state, metrics, and Discord-aware tool-name
 * checks. The escalation order is unchanged and is the point of the design:
 *
 *  1. Prune bulky archived tool output — cheap, and often enough on its own.
 *  2. Merge the existing summary frontier — reuses work already paid for.
 *  3. Only then spend a summarization call on fresh messages.
 */

export const defaultPruneConfig: Omit<PruneConfig, "protectedToolNames"> = {
  protectedTailChars: 40_000,
  minToolChars: 2_000,
  minSavingsChars: 8_000,
  edgeChars: 500,
  marker: "[tool output pruned during compaction;",
}

/** Protects nothing; every tool output is prunable. */
export const pruneAllToolOutputs = (): boolean => false

function assistantContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("")
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
      if (call?.type === "function" && typeof call.id === "string" && typeof call.function?.name === "string") {
        names.set(call.id, call.function.name)
      }
    }
  }
  return names
}

/**
 * Replaces large tool results with a marker plus head/tail excerpt.
 *
 * The full output stays in the verbatim archive, so the excerpt carries a hint
 * about how to recover it. Returns the input unchanged when the saving would be
 * too small to be worth the lost fidelity.
 */
export function pruneToolOutputsForCompaction(messages: Message[], config: PruneConfig): PruneResult {
  let protectedStart = messages.length
  let protectedChars = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    protectedStart = index
    protectedChars += assistantContentText(messages[index]?.content).length
    if (protectedChars >= config.protectedTailChars) break
  }

  const toolNames = toolCallNameMap(messages)
  let prunedMessages = 0
  let removedChars = 0
  const pruned = messages.map((message, index) => {
    if (index >= protectedStart || message.role !== "tool" || typeof message.content !== "string") return message
    const content = message.content
    if (content.length < config.minToolChars || content.startsWith(config.marker)) return message
    const toolCallId = (message as unknown as { tool_call_id?: unknown }).tool_call_id
    const toolName = typeof toolCallId === "string" ? (toolNames.get(toolCallId) ?? "") : ""
    if (config.protectedToolNames(toolName)) return message

    const replacement =
      `${config.marker} ${content.length} chars archived; tool=${toolName}. ` +
      "search the context archive with context_grep and a distinctive retained snippet to recover exact output]\n" +
      `${content.slice(0, config.edgeChars)}\n...\n${content.slice(-config.edgeChars)}`
    if (replacement.length >= content.length) return message
    prunedMessages++
    removedChars += content.length - replacement.length
    return { ...message, content: replacement } as Message
  })

  if (removedChars < config.minSavingsChars) return { messages, prunedMessages: 0, removedChars: 0 }
  return { messages: pruned, prunedMessages, removedChars }
}

/**
 * A follow-up compaction over only a handful of new messages produces a worse
 * summary than it saves tokens, so defer until either enough new material has
 * accumulated or the hard ceiling is reached.
 */
export function shouldDeferSmallFollowUpCompaction(
  hasPriorSummary: boolean,
  candidateCount: number,
  observedPromptTokens: number,
  config: LcmConfig,
): boolean {
  return (
    hasPriorSummary &&
    candidateCount < config.compactMinNewMessages &&
    observedPromptTokens < config.compactHardTriggerTokens
  )
}

export type CompactorDeps = {
  agentName: string
  archive: SqliteContextArchive
  lcm: LcmEngine
  config: LcmConfig
  prompts: SummaryPrompts
  prune: PruneConfig
  /** Resolves the summarization model, or null when its circuit is open. */
  resolveSummarizer(): Promise<{ model: SummarizerModel; circuit: SummaryCircuit } | null>
  /** Verbatim-preserving tail sizing, shared with the loop. */
  recentMinKeep: number
  recentMaxKeep: number
  tailCharBudget: number
  /** Tool schema included in the token estimate; sizes vary a lot per harness. */
  toolsForEstimate?: () => unknown
}

export function createContextCompactor(deps: CompactorDeps): ContextCompactor {
  const { agentName, archive, lcm, config, prompts } = deps
  const tools = () => deps.toolsForEstimate?.() ?? []

  const estimate = (messages: Message[]): number => estimatePromptTokens(messages, tools())

  return {
    config,

    async maybeCompact(input): Promise<CompactionOutcome> {
      const { messages, observedPromptTokens, phase } = input
      const unchanged = (): CompactionOutcome => ({
        applied: false,
        method: phase,
        beforeTokens: observedPromptTokens,
        afterTokens: observedPromptTokens,
        messages,
      })

      // Gate on the model-reported prompt size. A char-based estimate inflates
      // the tool schema several-fold and used to fire compaction far too early.
      if (observedPromptTokens < config.compactTriggerTokens) return unchanged()

      // ── 1. prune archived tool output ──────────────────────────────────
      let working = messages
      let mechanicallyPruned = false
      const pruneResult = pruneToolOutputsForCompaction(working, deps.prune)
      if (pruneResult.prunedMessages > 0) {
        const before = estimate(working)
        archive.archiveMessages(working, `${phase}-tool-prune`)
        working = pruneResult.messages
        mechanicallyPruned = true
        const after = estimate(working)
        console.log(
          `[context agent=${agentName}] ${phase}: pruned ${pruneResult.prunedMessages} archived tool output(s) ` +
            `(${before} -> ${after} tokens, removed=${pruneResult.removedChars} chars)`,
        )
        if (after < config.compactTriggerTokens) {
          return { applied: true, method: `${phase}-tool-prune`, beforeTokens: before, afterTokens: after, messages: working }
        }
      }

      const summarizer = await deps.resolveSummarizer()
      if (!summarizer) {
        console.warn(`[context agent=${agentName}] ${phase}: no summary provider available; skipping llm compaction`)
        return mechanicallyPruned
          ? { applied: true, method: `${phase}-tool-prune`, beforeTokens: observedPromptTokens, afterTokens: estimate(working), messages: working }
          : unchanged()
      }
      const { model, circuit } = summarizer

      const beforeTokens = estimate(working)
      const priorSummaryIndex = findSummaryMessageIndex(working)
      const candidateCount = countConversationCompactionCandidates(working, {
        recentMinKeep: deps.recentMinKeep,
        recentMaxKeep: deps.recentMaxKeep,
        tailCharBudget: deps.tailCharBudget,
      })
      const shouldDefer = shouldDeferSmallFollowUpCompaction(
        priorSummaryIndex >= 0,
        candidateCount,
        observedPromptTokens,
        config,
      )
      const canConsolidate = lcm.canConsolidateLcmFrontier(working)

      if (shouldDefer && !canConsolidate) {
        console.log(
          `[context agent=${agentName}] ${phase}: deferring follow-up compaction with only ${candidateCount} new candidate message(s)`,
        )
        return mechanicallyPruned
          ? { applied: true, method: `${phase}-tool-prune`, beforeTokens: observedPromptTokens, afterTokens: beforeTokens, messages: working }
          : unchanged()
      }

      const grounding: SummaryGrounding = input.grounding ?? null
      let directRecollection: string | null = null

      // ── 2. merge the existing frontier before touching fresh messages ──
      if (canConsolidate) {
        directRecollection = (await input.directRecollection?.()) ?? null
        const consolidated = await lcm.consolidateLcmFrontier(
          working, model, circuit, prompts, grounding, false, directRecollection,
        )
        if (consolidated.mergedSummaryIds.length > 0) {
          const afterTokens = estimate(consolidated.messages)
          console.log(
            `[context agent=${agentName}] ${phase}: merged lcm frontier (${beforeTokens} -> ${afterTokens} tokens, ` +
              `merged=${consolidated.mergedSummaryIds.join(",")})`,
          )
          return {
            applied: true,
            method: `${phase}-lcm-merge`,
            beforeTokens,
            afterTokens,
            messages: consolidated.messages,
            activeSummaryIds: consolidated.activeSummaryIds,
          }
        }
      }

      if (shouldDefer) return unchanged()

      // ── 3. summarize fresh messages ────────────────────────────────────
      const summarizeOptions = {
        recentMinKeep: deps.recentMinKeep,
        recentMaxKeep: deps.recentMaxKeep,
        tailCharBudget: deps.tailCharBudget,
        agentContext: grounding,
      }
      const preflight = await summarizeConversationViaLLMWithProvenance(
        agentName, working, model, circuit, prompts, summarizeOptions,
      )
      if (!preflight) {
        console.warn(`[context agent=${agentName}] ${phase}: llm summary unavailable; keeping raw conversation`)
        return mechanicallyPruned
          ? { applied: true, method: `${phase}-tool-prune`, beforeTokens: observedPromptTokens, afterTokens: beforeTokens, messages: working }
          : unchanged()
      }

      // Re-summarize with the agent's own testimony woven in, so compression
      // preserves first-person detail rather than only a third-party précis.
      directRecollection ??= (await input.directRecollection?.()) ?? null
      let compaction = preflight
      if (directRecollection) {
        const recollected = await summarizeConversationViaLLMWithProvenance(
          agentName, working, model, circuit, prompts, { ...summarizeOptions, directRecollection },
        )
        if (recollected) {
          compaction = recollected
        } else {
          // Keep the viable preflight summary, but preserve the exact testimony
          // in provenance rather than losing it.
          console.warn(`[context agent=${agentName}] ${phase}: testimony weave unavailable; preserving it in provenance`)
          compaction = {
            ...preflight,
            compactedMessages: [
              ...preflight.compactedMessages,
              { role: "user", content: prompts.recollectionPrompt },
              { role: "assistant", content: directRecollection },
            ],
          }
        }
      }

      const afterEstimate = estimate(compaction.messages)
      if (afterEstimate >= beforeTokens) {
        console.warn(
          `[context agent=${agentName}] ${phase}: llm summary not smaller (${beforeTokens} -> ${afterEstimate}); keeping raw conversation`,
        )
        return mechanicallyPruned
          ? { applied: true, method: `${phase}-tool-prune`, beforeTokens: observedPromptTokens, afterTokens: beforeTokens, messages: working }
          : unchanged()
      }

      const committed = await lcm.commitLcmCompaction(
        compaction, model, circuit, prompts, `${phase}-llm`, grounding,
      )
      const afterTokens = estimate(committed.messages)
      console.log(
        `[context agent=${agentName}] ${phase}: added lcm segment via ${model.model} ` +
          `(${beforeTokens} -> ${afterTokens} tokens, leaf=${committed.leafSummaryId})`,
      )

      return {
        applied: true,
        method: `${phase}-llm`,
        beforeTokens,
        afterTokens,
        messages: committed.messages,
        summaryText: compaction.summaryContent,
        leafSummaryId: committed.leafSummaryId,
        activeSummaryIds: committed.activeSummaryIds,
      }
    },
  }
}

export type RestCompactionInput = {
  agentName: string
  archive: SqliteContextArchive
  lcm: LcmEngine
  prompts: SummaryPrompts
  model: SummarizerModel
  circuit: SummaryCircuit
  conversation: Message[]
  grounding: SummaryGrounding
  /** The agent's own account of the session, collected before this runs. */
  directRecollection: string | null
}

/**
 * Folds an entire conversation into one summary segment.
 *
 * The in-loop compactor always keeps a verbatim tail so the agent can carry on
 * mid-task. At rest there is no next turn to preserve for, so the tail budget
 * goes to zero and everything becomes summary — the raw messages remain in the
 * archive and stay reachable by id.
 *
 * Returns the input unchanged if the summarizer declines, so resting is never
 * blocked by a model failure.
 */
export async function commitRestCompaction(input: RestCompactionInput): Promise<Message[]> {
  const { agentName, prompts, model, circuit } = input
  const compaction = await summarizeConversationViaLLMWithProvenance(
    agentName,
    input.conversation,
    model,
    circuit,
    prompts,
    {
      recentMinKeep: 0,
      recentMaxKeep: 0,
      tailCharBudget: 0,
      agentContext: input.grounding,
      directRecollection: input.directRecollection,
    },
  )
  if (!compaction) return input.conversation

  const committed = await input.lcm.commitLcmCompaction(
    compaction, model, circuit, prompts, "rest-llm", input.grounding,
  )
  return committed.messages
}
