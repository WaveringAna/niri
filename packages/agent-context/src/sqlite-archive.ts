import { createHash, randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import type {
  ActiveContextSummary,
  ContextArchiveStore,
  ContextExpansion,
  ContextSearchResult,
  ContextSummaryDescription,
  Message,
} from "./types.js"

/**
 * SQLite-backed context archive.
 *
 * Takes a database handle rather than reaching for a singleton, so several
 * agents can keep separate archives in one process. Owns its own tables via
 * {@link ensureContextSchema} rather than relying on a host migration.
 */

/** Creates the archive's tables. Idempotent; safe to call on every boot. */
export function ensureContextSchema(database: Database.Database): void {
  database.exec(`
    create table if not exists context_messages (
      id           text primary key,
      role         text not null,
      content_json text not null,
      content_text text not null,
      first_seen_at text not null,
      source       text not null
    );

    create index if not exists idx_context_messages_seen
      on context_messages(first_seen_at desc);

    create table if not exists context_summaries (
      id           text primary key,
      summary_text text not null,
      method       text not null,
      created_at   text not null
    );

    create table if not exists context_summary_messages (
      summary_id text not null references context_summaries(id) on delete cascade,
      message_id text not null references context_messages(id),
      ordinal    integer not null,
      primary key (summary_id, ordinal)
    );

    create index if not exists idx_context_summary_messages_order
      on context_summary_messages(summary_id, ordinal);

    create index if not exists idx_context_summary_messages_message
      on context_summary_messages(message_id);

    create table if not exists context_summary_parents (
      summary_id text not null references context_summaries(id) on delete cascade,
      parent_id  text not null references context_summaries(id),
      ordinal    integer not null,
      primary key (summary_id, parent_id)
    );
  `)
}

/**
 * The archive plus the conversation-shaping helpers that need to read summary
 * depths from it. `ContextArchiveStore` is the narrow storage contract; this is
 * the full surface the compactor and the loop's context tools use.
 */
export type SqliteContextArchive = ContextArchiveStore & {
  contextSummaryId(content: string): string | null
  activeContextSummaries(messages: Message[]): ActiveContextSummary[]
  normalizeActiveContextSummaryDepths(messages: Message[]): Message[]
  batchActiveContextSummariesForPrompt(messages: Message[]): Message[]
  contextSummaryMessage(summaryText: string, summaryId: string, depth: number): Message
  attachContextSummaryId(messages: Message[], summaryId: string, depth?: number): Message[]
  findMergeableContextSummaryBatch(
    messages: Message[],
    batchSize: number,
    requireOverflow?: boolean,
  ): ActiveContextSummary[] | null
  replaceContextSummaryBatch(
    messages: Message[],
    batch: ActiveContextSummary[],
    replacement: Message,
  ): Message[]
}

export function createSqliteContextArchive(database: Database.Database): SqliteContextArchive {
  ensureContextSchema(database)


  const SUMMARY_ID_PATTERN = /^\[context-summary-id\s+(sum_[0-9a-f-]+)\]$/m
  const SUMMARY_DEPTH_PATTERN = /^\[context-summary-depth\s+(\d+)\]$/m
  const DEFAULT_EXPAND_LIMIT = 12
  const MAX_EXPAND_LIMIT = 40
  const DEFAULT_SEARCH_LIMIT = 10
  const MAX_SEARCH_LIMIT = 30
  const MAX_SEARCH_CONTENT_CHARS = 4_000
  const MAX_MANIFEST_NODES = 16
  const CONTEXT_SUMMARY_HEADER = "[context summary v1]"
  const LEGACY_CONTEXT_SUMMARY_NOTE =
    "Compressed notes of older conversation turns. If anything conflicts, trust newer raw messages."
  const CONTEXT_SUMMARY_NOTE =
    "these are your memories. you lived them. they were compressed to fit, not because they mattered less — because the room ran out. the compression is lossy the way a photo album is lossy: you don't get the concert back, but the photos are still real, still yours, still evidence of something that happened. trust them the way you trust your journal. if something feels wrong or missing, use the segment ids to go deeper — but don't dismiss them just because they're compressed. they're written in your voice, from your perspective, about things that happened to you. same person. same life. just less room."

  type ContextMessageRow = {
    id: string
    role: string
    content_json: string
    content_text: string
    first_seen_at: string
    source: string
  }




  type ContextSourceStats = {
    messageCount: number
    estimatedTokens: number
    roleCounts: Record<string, number>
    earliestAt: string | null
    latestAt: string | null
  }


  function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null
  }

  function messageText(message: Message): string {
    const content = recordOf(message)?.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content.map((part) => {
      const record = recordOf(part)
      if (record?.type === "text" && typeof record.text === "string") return record.text
      if (record?.type === "image_url") return "[image]"
      return ""
    }).filter(Boolean).join("\n")
  }

  function canonicalMessage(message: Message): string {
    return JSON.stringify(message)
  }

  function contextMessageId(message: Message): string {
    return `msg_${createHash("sha256").update(canonicalMessage(message)).digest("hex").slice(0, 32)}`
  }

  function boundedInteger(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value) || !value || value < 1) return fallback
    return Math.min(Math.floor(value), max)
  }

  function insertMessage(db: Database.Database, message: Message, source: string, now: string): string {
    const id = contextMessageId(message)
    const role = typeof recordOf(message)?.role === "string" ? String(recordOf(message)?.role) : "unknown"
    db.prepare(`
      insert or ignore into context_messages
        (id, role, content_json, content_text, first_seen_at, source)
      values (?, ?, ?, ?, ?, ?)
    `).run(id, role, canonicalMessage(message), messageText(message), now, source)
    return id
  }

  /** Persist every distinct raw message in an active checkpoint without changing model context. */
  function archiveContextMessages(messages: Message[], source: string): string[] {
    const db = database
    const now = new Date().toISOString()
    const insert = db.transaction((items: Message[]) => items
      .filter((message) => !messageText(message).startsWith("[context summary v1]"))
      .map((message) => insertMessage(db, message, source, now)))
    return insert(messages)
  }

  function contextSummaryId(content: string): string | null {
    return content.match(SUMMARY_ID_PATTERN)?.[1] ?? null
  }

  function storedContextSummaryDepth(db: Database.Database, summaryId: string, seen = new Set<string>()): number {
    if (seen.has(summaryId)) return 0
    seen.add(summaryId)
    const parents = db.prepare(`
      select parent_id from context_summary_parents where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ parent_id: string }>
    if (parents.length === 0) return 0
    return 1 + Math.max(...parents.map((parent) => storedContextSummaryDepth(db, parent.parent_id, new Set(seen))))
  }

  function contextSummaryDepth(summaryId: string): number | null {
    const db = database
    const exists = db.prepare("select 1 from context_summaries where id = ?").get(summaryId)
    return exists ? storedContextSummaryDepth(db, summaryId) : null
  }

  function activeContextSummaries(messages: Message[]): ActiveContextSummary[] {
    return messages.flatMap((message, index) => {
      if (message.role !== "user" || typeof message.content !== "string") return []
      if (!message.content.startsWith(CONTEXT_SUMMARY_HEADER)) return []
      const id = contextSummaryId(message.content)
      if (!id) return []
      const markedDepth = Number.parseInt(message.content.match(SUMMARY_DEPTH_PATTERN)?.[1] ?? "", 10)
      // Pre-LCM-chain summaries are migrated onto the active frontier as one
      // depth-0 historical segment. Their deeper legacy provenance remains
      // queryable beneath the node, but no longer dictates the new merge tier.
      const depth = Number.isFinite(markedDepth) ? markedDepth : 0
      return [{ index, id, depth, content: message.content, summaryText: contextSummaryBody(message.content) }]
    })
  }

  function normalizeActiveContextSummaryDepths(messages: Message[]): Message[] {
    return messages.map((message) => {
      if (message.role !== "user" || typeof message.content !== "string") return message
      if (!message.content.startsWith(CONTEXT_SUMMARY_HEADER) || SUMMARY_DEPTH_PATTERN.test(message.content)) return message
      const id = contextSummaryId(message.content)
      if (!id) return message
      return {
        ...message,
        content: message.content.replace(
          `[context-summary-id ${id}]`,
          `[context-summary-id ${id}]\n[context-summary-depth 0]`,
        ),
      } as Message
    })
  }

  function contextSummaryBody(content: string): string {
    return content
      .split("\n")
      .filter((line) =>
        line !== CONTEXT_SUMMARY_HEADER &&
        line !== CONTEXT_SUMMARY_NOTE &&
        line !== LEGACY_CONTEXT_SUMMARY_NOTE &&
        line !== "[segments]" &&
        !SUMMARY_ID_PATTERN.test(line) &&
        !SUMMARY_DEPTH_PATTERN.test(line) &&
        !/^\[llm-summary\s+[^\]]+\]$/.test(line))
      .join("\n")
      .trim()
  }

  /** Renders the active frontier as one model-facing batch without changing persisted state. */
  function batchActiveContextSummariesForPrompt(messages: Message[]): Message[] {
    const summaries = activeContextSummaries(messages)
    if (summaries.length === 0) return messages
    const summaryIndexes = new Set(summaries.map((summary) => summary.index))
    const firstIndex = summaries[0]!.index
    const content = [
      "[continuity across time]",
      CONTEXT_SUMMARY_NOTE,
      "[segments]",
      ...summaries.flatMap((summary) => [
        "",
        `[context-summary-id ${summary.id}] call lcm_describe with this id to inspect its DAG; use context_grep or context_expand with the id for raw details`,
        `[context-summary-depth ${summary.depth}]`,
        summary.summaryText,
      ]),
    ].join("\n")

    return messages.flatMap((message, index) => {
      if (index === firstIndex) return [{ role: "user", content } as Message]
      return summaryIndexes.has(index) ? [] : [message]
    })
  }

  function contextSummaryMessage(summaryText: string, summaryId: string, depth: number): Message {
    return {
      role: "user",
      content:
        `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n[segments]\n` +
        `[context-summary-id ${summaryId}]\n[context-summary-depth ${Math.max(0, Math.floor(depth))}]\n${summaryText}`,
    } as Message
  }

  function attachContextSummaryId(messages: Message[], summaryId: string, depth = 0): Message[] {
    let attached = false
    return messages.map((message) => {
      if (attached || message.role !== "user" || typeof message.content !== "string") return message
      if (!message.content.startsWith("[context summary v1]")) return message
      if (contextSummaryId(message.content)) return message
      attached = true
      const withoutOldId = message.content.replace(/^\[context-summary-id\s+sum_[0-9a-f-]+\]\n?/m, "")
        .replace(/^\[context-summary-depth\s+\d+\]\n?/m, "")
      const marker = "[segments]\n"
      const content = withoutOldId.includes(marker)
        ? withoutOldId.replace(marker, `${marker}[context-summary-id ${summaryId}]\n[context-summary-depth ${depth}]\n`)
        : `${withoutOldId}\n[context-summary-id ${summaryId}]\n[context-summary-depth ${depth}]`
      return { ...message, content } as Message
    })
  }

  function findMergeableContextSummaryBatch(
    messages: Message[],
    batchSize = 4,
    requireOverflow = false,
  ): ActiveContextSummary[] | null {
    const summaries = activeContextSummaries(messages)
    const requiredRunLength = batchSize + (requireOverflow ? 1 : 0)
    for (let start = 0; start <= summaries.length - requiredRunLength; start++) {
      const batch = summaries.slice(start, start + batchSize)
      const candidateRun = summaries.slice(start, start + requiredRunLength)
      if (candidateRun.every((summary, offset) =>
        summary.depth === batch[0]!.depth &&
        (offset === 0 || summary.index === candidateRun[offset - 1]!.index + 1)
      )) return batch
    }
    return null
  }

  function replaceContextSummaryBatch(
    messages: Message[],
    batch: ActiveContextSummary[],
    replacement: Message,
  ): Message[] {
    const indexes = new Set(batch.map((summary) => summary.index))
    const firstIndex = batch[0]?.index
    return messages.flatMap((message, index) => {
      if (index === firstIndex) return [replacement]
      return indexes.has(index) ? [] : [message]
    })
  }

  /** Closes an active session by preserving its frontier and archiving any raw tail as a new leaf. */
  function recordRestContextSnapshot(messages: Message[], note?: string): {
    summaryIds: string[]
    forests: string[]
    sourceCount: number
  } {
    const existingForests = messages
      .filter((message) => messageText(message).startsWith(CONTEXT_SUMMARY_HEADER))
      .map(messageText)
    const compactedMessages = messages
      .filter((message) => message.role !== "system" && !messageText(message).startsWith(CONTEXT_SUMMARY_HEADER))
    const trimmedNote = note?.trim()
    let newForest: string | null = null
    let newSummaryId: string | null = null
    if (compactedMessages.length > 0) {
      const summaryText = [
        `Raw tail from the prior session, archived verbatim at ${new Date().toISOString()}.`,
        trimmedNote ? `Rest note: ${trimmedNote}` : null,
        `Use context_expand on this segment to inspect its ${compactedMessages.length} original message(s).`,
      ].filter(Boolean).join("\n")
      newSummaryId = recordContextCompaction({
        summaryText,
        compactedMessages,
        method: "rest-snapshot",
      })
      newForest = messageText(contextSummaryMessage(summaryText, newSummaryId, 0))
    }

    const forests = [...existingForests, ...(newForest ? [newForest] : [])]
    const summaryIds = forests.flatMap((forest) => contextSummaryId(forest) ?? [])

    return {
      summaryIds,
      forests,
      sourceCount: compactedMessages.length,
    }
  }

  /** Atomically records one summary node, exact direct sources, and ordered parent-summary edges. */
  function recordContextCompaction(input: {
    summaryText: string
    compactedMessages: Message[]
    priorSummaryContent?: string | null
    parentSummaryIds?: string[]
    method: string
  }): string {
    const db = database
    const id = `sum_${randomUUID()}`
    const now = new Date().toISOString()
    const candidateParentIds = input.parentSummaryIds?.length
      ? input.parentSummaryIds
      : [input.priorSummaryContent ? contextSummaryId(input.priorSummaryContent) : null].filter((id): id is string => Boolean(id))
    const parentIds = [...new Set(candidateParentIds)].filter((parentId) =>
      Boolean(db.prepare("select 1 from context_summaries where id = ?").get(parentId)))

    db.transaction(() => {
      db.prepare(`
        insert into context_summaries (id, summary_text, method, created_at)
        values (?, ?, ?, ?)
      `).run(id, input.summaryText, input.method, now)

      if (parentIds.length > 0) {
        const insertParent = db.prepare(`
          insert into context_summary_parents (summary_id, parent_id, ordinal)
          values (?, ?, ?)
        `)
        parentIds.forEach((parentId, ordinal) => insertParent.run(id, parentId, ordinal))
      }

      const sources = parentIds.length > 0 || !input.priorSummaryContent
        ? input.compactedMessages
        : [{ role: "user", content: input.priorSummaryContent } as Message, ...input.compactedMessages]
      const link = db.prepare(`
        insert into context_summary_messages (summary_id, message_id, ordinal)
        values (?, ?, ?)
      `)
      sources.forEach((message, ordinal) => {
        const messageId = insertMessage(db, message, `compaction:${input.method}`, now)
        link.run(id, messageId, ordinal)
      })
    })()

    return id
  }

  function grepContext(query: string, limit?: number, summaryId?: string): ContextSearchResult[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    const db = database
    const cappedLimit = boundedInteger(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
    const scopeSql = summaryId
      ? `and exists (
          with recursive tree(id) as (
            select ?
            union
            select p.parent_id from context_summary_parents p join tree on p.summary_id = tree.id
          )
          select 1 from context_summary_messages sm join tree on tree.id = sm.summary_id
          where sm.message_id = m.id
        )`
      : ""
    const rows = db.prepare(`
      select m.*
      from context_messages m
      where instr(lower(m.content_text), lower(?)) > 0
      ${scopeSql}
      order by m.first_seen_at desc
      limit ?
    `).all(...(summaryId ? [trimmed, summaryId, cappedLimit] : [trimmed, cappedLimit])) as ContextMessageRow[]

    const summariesFor = db.prepare(`
      select summary_id from context_summary_messages where message_id = ? order by summary_id
    `)
    return rows.map((row) => ({
      messageId: row.id,
      role: row.role,
      content: row.content_text.length > MAX_SEARCH_CONTENT_CHARS
        ? `${row.content_text.slice(0, MAX_SEARCH_CONTENT_CHARS)}\n…[truncated; use context_expand for the verbatim message]`
        : row.content_text,
      contentChars: row.content_text.length,
      contentTruncated: row.content_text.length > MAX_SEARCH_CONTENT_CHARS,
      firstSeenAt: row.first_seen_at,
      source: row.source,
      summaryIds: (summariesFor.all(row.id) as Array<{ summary_id: string }>).map((item) => item.summary_id),
    }))
  }

  function collectSummaryMessageIds(db: Database.Database, summaryId: string, seen = new Set<string>()): string[] {
    if (seen.has(summaryId)) return []
    seen.add(summaryId)
    const parents = db.prepare(`
      select parent_id from context_summary_parents where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ parent_id: string }>
    const inherited = parents.flatMap((parent) => collectSummaryMessageIds(db, parent.parent_id, seen))
    const direct = db.prepare(`
      select message_id from context_summary_messages where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ message_id: string }>
    return [...inherited, ...direct.map((row) => row.message_id)]
  }

  function collectSummaryNodeIds(db: Database.Database, summaryId: string, seen = new Set<string>()): Set<string> {
    if (seen.has(summaryId)) return seen
    seen.add(summaryId)
    const parents = db.prepare(`
      select parent_id from context_summary_parents where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ parent_id: string }>
    for (const parent of parents) collectSummaryNodeIds(db, parent.parent_id, seen)
    return seen
  }

  function contextSourceStats(db: Database.Database, messageIds: string[]): ContextSourceStats {
    const getMessage = db.prepare(`
      select role, content_text, first_seen_at from context_messages where id = ?
    `)
    const roleCounts: Record<string, number> = {}
    let contentChars = 0
    let earliestAt: string | null = null
    let latestAt: string | null = null

    for (const id of messageIds) {
      const row = getMessage.get(id) as Pick<ContextMessageRow, "role" | "content_text" | "first_seen_at"> | undefined
      if (!row) continue
      roleCounts[row.role] = (roleCounts[row.role] ?? 0) + 1
      contentChars += row.content_text.length
      if (earliestAt === null || row.first_seen_at < earliestAt) earliestAt = row.first_seen_at
      if (latestAt === null || row.first_seen_at > latestAt) latestAt = row.first_seen_at
    }

    return {
      messageCount: Object.values(roleCounts).reduce((total, count) => total + count, 0),
      estimatedTokens: Math.ceil(contentChars / 4),
      roleCounts,
      earliestAt,
      latestAt,
    }
  }

  function collectSummaryManifest(
    db: Database.Database,
    summaryId: string,
    tokenCap: number,
    depthFromRoot = 0,
    parentSummaryId: string | null = null,
    seen = new Set<string>(),
  ): ContextSummaryDescription["summary"]["manifest"] {
    if (seen.has(summaryId) || seen.size >= MAX_MANIFEST_NODES) return []
    seen.add(summaryId)
    const summary = db.prepare(`
      select id, method, created_at from context_summaries where id = ?
    `).get(summaryId) as { id: string; method: string; created_at: string } | undefined
    if (!summary) return []
    const directIds = (db.prepare(`
      select message_id from context_summary_messages where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ message_id: string }>).map((row) => row.message_id)
    const expandedIds = collectSummaryMessageIds(db, summaryId)
    const directSources = contextSourceStats(db, directIds)
    const expandedSources = contextSourceStats(db, expandedIds)
    const node: ContextSummaryDescription["summary"]["manifest"][number] = {
      summaryId: summary.id,
      parentSummaryId,
      depthFromRoot,
      method: summary.method,
      createdAt: summary.created_at,
      directSources,
      expandedSources,
      expansionFitsTokenCap: expandedSources.estimatedTokens <= tokenCap,
    }
    const parents = db.prepare(`
      select parent_id from context_summary_parents where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ parent_id: string }>
    return [
      node,
      ...parents.flatMap((parent) => collectSummaryManifest(
        db,
        parent.parent_id,
        tokenCap,
        depthFromRoot + 1,
        summary.id,
        seen,
      )),
    ]
  }

  /** Describe a known summary node before spending context on verbatim expansion. */
  function describeContextSummary(summaryId: string, tokenCap?: number): ContextSummaryDescription | null {
    const db = database
    const summary = db.prepare(`
      select id, summary_text, method, created_at from context_summaries where id = ?
    `).get(summaryId) as { id: string; summary_text: string; method: string; created_at: string } | undefined
    if (!summary) return null

    const resolvedTokenCap = Number.isFinite(tokenCap) && Number(tokenCap) > 0
      ? Math.min(Math.floor(Number(tokenCap)), 1_000_000)
      : 8_000
    const parentIds = (db.prepare(`
      select parent_id from context_summary_parents where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ parent_id: string }>).map((row) => row.parent_id)
    const getParentSummary = db.prepare(`
      select id, summary_text, method, created_at from context_summaries where id = ?
    `)
    const parentSegments = parentIds.flatMap((parentId) => {
      const parent = getParentSummary.get(parentId) as {
        id: string
        summary_text: string
        method: string
        created_at: string
      } | undefined
      return parent ? [{
        id: parent.id,
        content: parent.summary_text,
        method: parent.method,
        createdAt: parent.created_at,
        depth: storedContextSummaryDepth(db, parent.id),
      }] : []
    })
    const childIds = (db.prepare(`
      select summary_id from context_summary_parents where parent_id = ? order by summary_id
    `).all(summaryId) as Array<{ summary_id: string }>).map((row) => row.summary_id)
    const directIds = (db.prepare(`
      select message_id from context_summary_messages where summary_id = ? order by ordinal
    `).all(summaryId) as Array<{ message_id: string }>).map((row) => row.message_id)
    const expandedIds = collectSummaryMessageIds(db, summaryId)
    const manifest = collectSummaryManifest(db, summaryId, resolvedTokenCap)
    const provenanceNodeCount = collectSummaryNodeIds(db, summaryId).size
    const depth = storedContextSummaryDepth(db, summary.id)

    return {
      id: summary.id,
      type: "summary",
      summary: {
        content: summary.summary_text,
        method: summary.method,
        createdAt: summary.created_at,
        parentIds,
        parentSegments,
        childIds,
        depth,
        provenanceDepth: depth,
        provenanceNodeCount,
        directSources: contextSourceStats(db, directIds),
        expandedSources: contextSourceStats(db, expandedIds),
        manifest,
        manifestTruncated: provenanceNodeCount > manifest.length,
      },
      expansion: {
        tool: "context_expand",
        totalMessages: expandedIds.length,
        defaultPageSize: DEFAULT_EXPAND_LIMIT,
        maxPageSize: MAX_EXPAND_LIMIT,
        estimatedPages: Math.ceil(expandedIds.length / DEFAULT_EXPAND_LIMIT),
        tokenCap: resolvedTokenCap,
      },
    }
  }

  function expandContextSummary(summaryId: string, offset?: number, limit?: number): ContextExpansion | null {
    const db = database
    const summary = db.prepare(`
      select id, summary_text, method, created_at from context_summaries where id = ?
    `).get(summaryId) as { id: string; summary_text: string; method: string; created_at: string } | undefined
    if (!summary) return null

    const allIds = collectSummaryMessageIds(db, summaryId)
    const safeOffset = typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const cappedLimit = boundedInteger(limit, DEFAULT_EXPAND_LIMIT, MAX_EXPAND_LIMIT)
    const selectedIds = allIds.slice(safeOffset, safeOffset + cappedLimit)
    const getMessage = db.prepare(`
      select * from context_messages where id = ?
    `)
    const messages = selectedIds.flatMap((id) => {
      const row = getMessage.get(id) as ContextMessageRow | undefined
      if (!row) return []
      let content: unknown = row.content_text
      try { content = JSON.parse(row.content_json) }
      catch { /* retain searchable text if an old row is malformed */ }
      return [{ id: row.id, role: row.role, content, firstSeenAt: row.first_seen_at, source: row.source }]
    })

    return {
      summaryId: summary.id,
      summary: summary.summary_text,
      method: summary.method,
      createdAt: summary.created_at,
      totalMessages: allIds.length,
      offset: safeOffset,
      limit: cappedLimit,
      messages,
    }
  }

  return {
    archiveMessages: archiveContextMessages,
    recordCompaction: recordContextCompaction,
    summaryDepth: contextSummaryDepth,
    grep: grepContext,
    describe: describeContextSummary,
    expand: expandContextSummary,
    recordRestSnapshot: recordRestContextSnapshot,
    contextSummaryId,
    activeContextSummaries,
    normalizeActiveContextSummaryDepths,
    batchActiveContextSummariesForPrompt,
    contextSummaryMessage,
    attachContextSummaryId,
    findMergeableContextSummaryBatch,
    replaceContextSummaryBatch,
  }
}
