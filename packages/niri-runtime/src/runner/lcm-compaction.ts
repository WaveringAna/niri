import OpenAI from "openai"
import { AGENT_ID } from "../agent-config"
import type { Message } from "../types"
import {
  activeContextSummaries,
  attachContextSummaryId,
  contextSummaryMessage,
  findMergeableContextSummaryBatch,
  normalizeActiveContextSummaryDepths,
  recordContextCompaction,
  replaceContextSummaryBatch,
} from "./context-store"
import {
  COMPACTION_RECOLLECTION_PROMPT,
  summarizeContextSummaryBatchViaLLM,
  type ConversationCompaction,
} from "./util"

const LCM_SUMMARY_BATCH_SIZE = Math.max(
  2,
  Number.parseInt(process.env.LCM_SUMMARY_BATCH_SIZE ?? "4", 10) || 4,
)

export type CommittedLcmCompaction = {
  messages: Message[]
  leafSummaryId: string
  mergedSummaryIds: string[]
  activeSummaryIds: string[]
}

export type ConsolidatedLcmFrontier = {
  messages: Message[]
  mergedSummaryIds: string[]
  activeSummaryIds: string[]
}

export function canConsolidateLcmFrontier(
  messages: Message[],
  requireOverflow = false,
): boolean {
  return findMergeableContextSummaryBatch(
    normalizeActiveContextSummaryDepths(messages),
    LCM_SUMMARY_BATCH_SIZE,
    requireOverflow,
  ) !== null
}

export async function consolidateLcmFrontier(
  initialMessages: Message[],
  summaryClient: OpenAI,
  summaryModel: string,
  agentContext?: string | null,
  requireOverflow = false,
  directRecollection?: string | null,
): Promise<ConsolidatedLcmFrontier> {
  let messages = normalizeActiveContextSummaryDepths(initialMessages)
  const mergedSummaryIds: string[] = []
  let directRecollectionArchived = false

  while (true) {
    const batch = findMergeableContextSummaryBatch(messages, LCM_SUMMARY_BATCH_SIZE, requireOverflow)
    if (!batch) break
    const merged = await summarizeContextSummaryBatchViaLLM(
      batch.map((segment) => ({ id: segment.id, depth: segment.depth, content: segment.summaryText })),
      summaryClient,
      summaryModel,
      { agentContext, directRecollection },
    )
    if (!merged) {
      console.warn(
        `[context agent=${AGENT_ID}] lcm: unable to merge ${batch.length} depth-${batch[0]!.depth} segments; keeping frontier`,
      )
      break
    }

    const mergedDepth = batch[0]!.depth + 1
    const compactedMessages: Message[] = directRecollection?.trim() && !directRecollectionArchived
      ? [
          { role: "user", content: COMPACTION_RECOLLECTION_PROMPT },
          { role: "assistant", content: directRecollection },
        ]
      : []
    const mergedSummaryId = recordContextCompaction({
      summaryText: merged.summaryText,
      compactedMessages,
      parentSummaryIds: batch.map((segment) => segment.id),
      method: `lcm-merge-d${mergedDepth}`,
    })
    if (compactedMessages.length > 0) directRecollectionArchived = true
    messages = replaceContextSummaryBatch(
      messages,
      batch,
      contextSummaryMessage(merged.summaryText, mergedSummaryId, mergedDepth),
    )
    mergedSummaryIds.push(mergedSummaryId)
    console.log(
      `[context agent=${AGENT_ID}] lcm: merged ${batch.map((segment) => segment.id).join(",")} -> ${mergedSummaryId} at depth ${mergedDepth}`,
    )
  }

  return {
    messages,
    mergedSummaryIds,
    activeSummaryIds: activeContextSummaries(messages).map((summary) => summary.id),
  }
}

/**
 * Persists one raw-history segment, appends it to the active frontier, then
 * repeatedly promotes ordered same-depth batches into multi-parent summaries.
 */
export async function commitLcmCompaction(
  compaction: ConversationCompaction,
  summaryClient: OpenAI,
  summaryModel: string,
  method: string,
  agentContext?: string | null,
): Promise<CommittedLcmCompaction> {
  const leafSummaryId = recordContextCompaction({
    summaryText: compaction.summaryText,
    compactedMessages: compaction.compactedMessages,
    method,
  })
  const messages = normalizeActiveContextSummaryDepths(
    attachContextSummaryId(compaction.messages, leafSummaryId, 0),
  )
  const consolidated = await consolidateLcmFrontier(
    messages,
    summaryClient,
    summaryModel,
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

export const __lcmCompactionTest = {
  batchSize: LCM_SUMMARY_BATCH_SIZE,
}
