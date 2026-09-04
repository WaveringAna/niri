import type {
  CommittedLcmCompaction,
  ConsolidatedLcmFrontier,
  ConversationCompaction,
  Message,
  SummarizerModel,
  SummaryCircuit,
  SummaryPrompts,
} from "./types.js"
import type { SqliteContextArchive } from "./sqlite-archive.js"
import { summarizeContextSummaryBatchViaLLM } from "./summarize.js"

/**
 * Layered context memory.
 *
 * Compaction produces a depth-0 summary over raw messages; once enough
 * same-depth segments accumulate they are merged into a depth-n+1 parent, so
 * the active conversation holds a shallow frontier while the full history stays
 * recoverable as a DAG in the archive.
 *
 * Ported from `@niri/runtime`'s `runner/lcm-compaction.ts`. The archive, the
 * summarizer, and the batch size are injected instead of imported.
 */

export type LcmDeps = {
  archive: SqliteContextArchive
  agentName: string
  /** Same-depth segments merged into one parent. */
  batchSize: number
}

export type LcmEngine = {
  canConsolidateLcmFrontier(messages: Message[], requireOverflow?: boolean): boolean
  consolidateLcmFrontier(
    initialMessages: Message[],
    model: SummarizerModel,
    circuit: SummaryCircuit,
    prompts: SummaryPrompts,
    agentContext?: string | null,
    requireOverflow?: boolean,
    directRecollection?: string | null,
  ): Promise<ConsolidatedLcmFrontier>
  commitLcmCompaction(
    compaction: ConversationCompaction,
    model: SummarizerModel,
    circuit: SummaryCircuit,
    prompts: SummaryPrompts,
    method: string,
    agentContext?: string | null,
  ): Promise<CommittedLcmCompaction>
}

export function createLcmEngine(deps: LcmDeps): LcmEngine {
  const { archive, agentName } = deps
  const batchSize = Math.max(2, deps.batchSize)

  function canConsolidateLcmFrontier(
    messages: Message[],
    requireOverflow = false,
  ): boolean {
    return archive.findMergeableContextSummaryBatch(
      archive.normalizeActiveContextSummaryDepths(messages),
      batchSize,
      requireOverflow,
    ) !== null
  }

  async function consolidateLcmFrontier(
    initialMessages: Message[],
    model: SummarizerModel,
    circuit: SummaryCircuit,
    prompts: SummaryPrompts,
    agentContext?: string | null,
    requireOverflow = false,
    directRecollection?: string | null,
  ): Promise<ConsolidatedLcmFrontier> {
    let messages = archive.normalizeActiveContextSummaryDepths(initialMessages)
    const mergedSummaryIds: string[] = []
    let directRecollectionArchived = false

    while (true) {
      const batch = archive.findMergeableContextSummaryBatch(messages, batchSize, requireOverflow)
      if (!batch) break
      const merged = await summarizeContextSummaryBatchViaLLM(
        agentName,
        batch.map((segment) => ({ id: segment.id, depth: segment.depth, content: segment.summaryText })),
        model,
        circuit,
        prompts,
        { agentContext, directRecollection },
      )
      if (!merged) {
        console.warn(
          `[context agent=${agentName}] lcm: unable to merge ${batch.length} depth-${batch[0]!.depth} segments; keeping frontier`,
        )
        break
      }

      const mergedDepth = batch[0]!.depth + 1
      const compactedMessages: Message[] = directRecollection?.trim() && !directRecollectionArchived
        ? [
            { role: "user", content: prompts.recollectionPrompt },
            { role: "assistant", content: directRecollection },
          ]
        : []
      const mergedSummaryId = archive.recordCompaction({
        summaryText: merged.summaryText,
        compactedMessages,
        parentSummaryIds: batch.map((segment) => segment.id),
        method: `lcm-merge-d${mergedDepth}`,
      })
      if (compactedMessages.length > 0) directRecollectionArchived = true
      messages = archive.replaceContextSummaryBatch(
        messages,
        batch,
        archive.contextSummaryMessage(merged.summaryText, mergedSummaryId, mergedDepth),
      )
      mergedSummaryIds.push(mergedSummaryId)
      console.log(
        `[context agent=${agentName}] lcm: merged ${batch.map((segment) => segment.id).join(",")} -> ${mergedSummaryId} at depth ${mergedDepth}`,
      )
    }

    return {
      messages,
      mergedSummaryIds,
      activeSummaryIds: archive.activeContextSummaries(messages).map((summary) => summary.id),
    }
  }

  /**
   * Persists one raw-history segment, appends it to the active frontier, then
   * repeatedly promotes ordered same-depth batches into multi-parent summaries.
   */
  async function commitLcmCompaction(
    compaction: ConversationCompaction,
    model: SummarizerModel,
    circuit: SummaryCircuit,
    prompts: SummaryPrompts,
    method: string,
    agentContext?: string | null,
  ): Promise<CommittedLcmCompaction> {
    const leafSummaryId = archive.recordCompaction({
      summaryText: compaction.summaryText,
      compactedMessages: compaction.compactedMessages,
      method,
    })
    const messages = archive.normalizeActiveContextSummaryDepths(
      archive.attachContextSummaryId(compaction.messages, leafSummaryId, 0),
    )
    const consolidated = await consolidateLcmFrontier(
      messages,
      model,
      circuit,
      prompts,
      agentContext,
      true,
    )

    return {
      messages: consolidated.messages,
      leafSummaryId,
      mergedSummaryIds: consolidated.mergedSummaryIds,
      activeSummaryIds: consolidated.activeSummaryIds,
    }
  }


  return { canConsolidateLcmFrontier, consolidateLcmFrontier, commitLcmCompaction }
}
