import type OpenAI from "openai"

/**
 * Conversation message. Structurally the OpenAI shape plus an optional
 * `reasoning_content` some providers require replayed back to them.
 */
export type AssistantMessageWithReasoning = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string
}
export type Message = OpenAI.Chat.ChatCompletionMessageParam | AssistantMessageWithReasoning

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/**
 * One verbatim message preserved in the immutable archive, with the summary
 * segments that now stand in for it.
 */
export type ArchivedMessage = {
  id: string
  role: string
  content: unknown
  firstSeenAt: string
  source: string
}

export type ContextSearchResult = {
  messageId: string
  role: string
  content: string
  contentChars: number
  /** True when `content` is a bounded preview, so a grep hit cannot flood context. */
  contentTruncated: boolean
  firstSeenAt: string
  source: string
  /** Summary segments whose provenance tree contains this message. */
  summaryIds: string[]
}

/** A summary segment currently occupying a slot in the live conversation. */
export type ActiveContextSummary = {
  /** Position in the conversation array. */
  index: number
  id: string
  /** 0 for a leaf summary over raw messages; n+1 for a merge of depth-n segments. */
  depth: number
  content: string
  summaryText: string
}

export type ContextExpansion = {
  summaryId: string
  summary: string
  method: string
  createdAt: string
  totalMessages: number
  offset: number
  limit: number
  messages: ArchivedMessage[]
}

export type ContextSourceStats = {
  messageCount: number
  estimatedTokens: number
  roleCounts: Record<string, number>
  earliestAt: string | null
  latestAt: string | null
}

/**
 * Everything an agent needs to decide whether expanding a summary is worth the
 * tokens: its lineage, how many raw messages sit beneath it, and a bounded
 * manifest of the expansion cost. Answering that *before* expanding is what
 * keeps the archive usable inside a bounded context window.
 */
export type ContextSummaryDescription = {
  id: string
  type: "summary"
  summary: {
    content: string
    method: string
    createdAt: string
    parentIds: string[]
    parentSegments: Array<{
      id: string
      content: string
      method: string
      createdAt: string
      depth: number
    }>
    childIds: string[]
    depth: number
    provenanceDepth: number
    provenanceNodeCount: number
    directSources: ContextSourceStats
    expandedSources: ContextSourceStats
    manifest: Array<{
      summaryId: string
      parentSummaryId: string | null
      depthFromRoot: number
      method: string
      createdAt: string
      directSources: ContextSourceStats
      expandedSources: ContextSourceStats
      expansionFitsTokenCap: boolean
    }>
    manifestTruncated: boolean
  }
  expansion: {
    tool: "context_expand"
    totalMessages: number
    defaultPageSize: number
    maxPageSize: number
    estimatedPages: number
    tokenCap: number
  }
}

export type RecordCompactionInput = {
  summaryText: string
  /** The raw messages this summary replaces; archived verbatim. */
  compactedMessages: Message[]
  /**
   * Content of the summary being superseded. When `parentSummaryIds` is
   * absent, the parent is recovered from the id embedded in this text, and the
   * superseded summary is archived alongside the raw messages so the chain
   * stays walkable.
   */
  priorSummaryContent?: string | null
  /** For a merge, the segment ids being subsumed. */
  parentSummaryIds?: string[]
  /** Provenance label, e.g. `pre-turn-llm`, `lcm-merge-d2`. */
  method: string
}

/**
 * Durable store behind the context archive.
 *
 * Implemented over SQLite in `@mira/agent-context/sqlite`, but the interface is
 * storage-neutral so a harness can back it with Postgres or keep it in memory
 * for tests. The archive is append-only: messages are never mutated or deleted,
 * which is what makes `contextExpand` trustworthy.
 */
export interface ContextArchiveStore {
  archiveMessages(messages: Message[], source: string): string[]
  recordCompaction(input: RecordCompactionInput): string
  summaryDepth(summaryId: string): number | null
  grep(query: string, limit?: number, summaryId?: string): ContextSearchResult[]
  describe(summaryId: string, tokenCap?: number): ContextSummaryDescription | null
  expand(summaryId: string, offset?: number, limit?: number): ContextExpansion | null
  recordRestSnapshot(messages: Message[], note?: string): {
    summaryIds: string[]
    /** Active summary contents at rest, replayed on the next wake. */
    forests: string[]
    sourceCount: number
  }
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/**
 * Text prepended to every summarization prompt to keep the summarizer grounded
 * in who the agent is. Niri passes soul + core memories + latest journal; a PR
 * reviewer passes its rubric, or nothing at all.
 */
export type SummaryGrounding = string | null

/**
 * The summarizer's prompts, as data.
 *
 * Niri's original prompt hard-coded a specific agent's voice and pronouns
 * ("a living being, not a tool", "her inner life") directly into compaction.
 * Making the prompts injectable is what lets a PR reviewer summarize a long
 * review with "preserve every finding, file path, and line number" instead.
 *
 * Every builder receives the same context, so an implementation can ignore what
 * it does not need.
 */
export type SummaryPromptContext = {
  agentName: string
  grounding: SummaryGrounding
  /** The agent's own pre-compaction testimony, if one was collected. */
  directRecollection: string | null
}

export type SummaryPrompts = {
  /** System prompt for summarizing one raw transcript segment. */
  segment(ctx: SummaryPromptContext): string
  /** System prompt for merging several same-depth segments into a parent. */
  merge(ctx: SummaryPromptContext): string
  /**
   * Extra instruction appended when a long transcript is summarized in several
   * chronological chunks, then consolidated.
   */
  chunkSuffix(part: number, total: number): string
  /** System prompt for the final consolidation of chunked partials. */
  consolidate(ctx: SummaryPromptContext): string
  /** Asked of the agent itself, in its own voice, before compaction. */
  recollectionPrompt: string
  /** System note for the recollection turn (no tools available). */
  recollectionTurnInstruction: string
  /** Label under which the recollection is woven into the summary prompt. */
  recollectionLabel: string
  /** Header line written into every summary message. */
  summaryHeader: string
  /** Explains to the model how to treat compressed context. */
  summaryNote: string
}

/**
 * Circuit-breaker callbacks. The summarizer reports provider quality here
 * (empty summary, meta-reply, no reduction) so the owner of the provider set
 * can stop calling a model that is not producing usable summaries.
 */
export interface SummaryCircuit {
  isOpen(): boolean
  recordFailure(err: unknown): void
  recordUnusable(reason: string): void
  recordSuccess(): void
}

export type SummarizeOptions = {
  /** Always keep at least this many trailing messages verbatim. */
  recentMinKeep: number
  /** Never keep more than this many trailing messages verbatim. */
  recentMaxKeep: number
  /** Character budget for the preserved tail. */
  tailCharBudget: number
  grounding?: SummaryGrounding
  /**
   * The agent's own recollection of the span being compacted, produced by a
   * dedicated turn. Woven into the summary so compression preserves first-person
   * testimony rather than only a third-party précis.
   */
  directRecollection?: string | null
}

export type ConversationCompaction = {
  /** The new conversation: system head + summary segment(s) + preserved tail. */
  messages: Message[]
  /** The raw messages that were replaced. */
  compactedMessages: Message[]
  /** Body of the generated summary, without the header/marker envelope. */
  summaryText: string
  /** Full summary message content including markers. */
  summaryContent: string
}

export type SummarySegmentInput = {
  id: string
  depth: number
  content: string
}

/**
 * Model access needed for compaction. Deliberately narrower than
 * `@mira/agent-llm`'s `Provider` so `@mira/agent-context` does not depend on
 * the whole provider stack — pass `providerSet.resolveSummary()`'s provider.
 */
export interface SummarizerModel {
  readonly id: string
  readonly model: string
  /** Runs a tool-free, non-streaming completion and returns its text. */
  completeText(system: string, user: string): Promise<string>
}

// ---------------------------------------------------------------------------
// LCM (layered context memory)
// ---------------------------------------------------------------------------

export type LcmConfig = {
  /** Same-depth segments merged into one parent. */
  summaryBatchSize: number
  /** Observed prompt tokens above which compaction runs. */
  compactTriggerTokens: number
  /** Ceiling that forces compaction even with few new messages. */
  compactHardTriggerTokens: number
  /** Below this many new candidate messages, defer a follow-up compaction. */
  compactMinNewMessages: number
}

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

/**
 * Result of one compaction attempt, returned to the loop so it can log and
 * emit metrics without knowing how compaction works.
 */
export type CompactionOutcome = {
  applied: boolean
  method: string
  beforeTokens: number
  afterTokens: number
  messages: Message[]
  summaryText?: string
  leafSummaryId?: string
  activeSummaryIds?: string[]
}

/**
 * Tool-output pruning: replaces bulky archived tool results with a marker and
 * head/tail excerpt before spending a summarization call. Cheap win that often
 * makes the LLM pass unnecessary.
 */
export type PruneConfig = {
  protectedTailChars: number
  minToolChars: number
  minSavingsChars: number
  edgeChars: number
  marker: string
  /**
   * Tool names whose output must never be pruned. Niri protects
   * `discord_*`/`memory_*`/`soul_*`; a reviewer protects its diff-fetch tools.
   */
  protectedToolNames: (toolName: string) => boolean
}

export type PruneResult = {
  messages: Message[]
  prunedMessages: number
  removedChars: number
}

/**
 * The compaction engine the loop drives. One method, called before and after
 * each turn; everything else is internal.
 */
export interface ContextCompactor {
  readonly config: LcmConfig
  /** No-op returning `applied: false` when below the trigger. */
  maybeCompact(input: {
    messages: Message[]
    observedPromptTokens: number
    phase: string
    grounding?: SummaryGrounding
    directRecollection?: () => Promise<string | null>
  }): Promise<CompactionOutcome>
}
