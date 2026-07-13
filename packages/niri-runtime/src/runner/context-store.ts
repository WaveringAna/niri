import { createHash, randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import { getDb } from "../db"
import type { Message } from "../types"

const SUMMARY_ID_PATTERN = /^\[context-summary-id\s+(sum_[0-9a-f-]+)\]$/m
const DEFAULT_EXPAND_LIMIT = 12
const MAX_EXPAND_LIMIT = 40
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 30

type ContextMessageRow = {
  id: string
  role: string
  content_json: string
  content_text: string
  first_seen_at: string
  source: string
}

export type ContextSearchResult = {
  messageId: string
  role: string
  content: string
  firstSeenAt: string
  source: string
  summaryIds: string[]
}

export type ContextExpansion = {
  summaryId: string
  summary: string
  method: string
  createdAt: string
  totalMessages: number
  offset: number
  limit: number
  messages: Array<{ id: string; role: string; content: unknown; firstSeenAt: string; source: string }>
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
export function archiveContextMessages(messages: Message[], source: string): string[] {
  const db = getDb()
  const now = new Date().toISOString()
  const insert = db.transaction((items: Message[]) => items
    .filter((message) => !messageText(message).startsWith("[context summary v1]"))
    .map((message) => insertMessage(db, message, source, now)))
  return insert(messages)
}

export function contextSummaryId(content: string): string | null {
  return content.match(SUMMARY_ID_PATTERN)?.[1] ?? null
}

export function attachContextSummaryId(messages: Message[], summaryId: string): Message[] {
  let attached = false
  return messages.map((message) => {
    if (attached || message.role !== "user" || typeof message.content !== "string") return message
    if (!message.content.startsWith("[context summary v1]")) return message
    attached = true
    const withoutOldId = message.content.replace(/^\[context-summary-id\s+sum_[0-9a-f-]+\]\n?/m, "")
    const marker = "[segments]\n"
    const content = withoutOldId.includes(marker)
      ? withoutOldId.replace(marker, `${marker}[context-summary-id ${summaryId}]\n`)
      : `${withoutOldId}\n[context-summary-id ${summaryId}]`
    return { ...message, content } as Message
  })
}

/** Atomically records one summary node, its exact source messages, and its prior-summary edge. */
export function recordContextCompaction(input: {
  summaryText: string
  compactedMessages: Message[]
  priorSummaryContent?: string | null
  method: string
}): string {
  const db = getDb()
  const id = `sum_${randomUUID()}`
  const now = new Date().toISOString()
  const candidateParentId = input.priorSummaryContent ? contextSummaryId(input.priorSummaryContent) : null
  const parentId = candidateParentId && db.prepare("select 1 from context_summaries where id = ?").get(candidateParentId)
    ? candidateParentId
    : null

  db.transaction(() => {
    db.prepare(`
      insert into context_summaries (id, summary_text, method, created_at)
      values (?, ?, ?, ?)
    `).run(id, input.summaryText, input.method, now)

    if (parentId) {
      db.prepare(`
        insert into context_summary_parents (summary_id, parent_id, ordinal)
        values (?, ?, 0)
      `).run(id, parentId)
    }

    const sources = parentId || !input.priorSummaryContent
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

export function grepContext(query: string, limit?: number, summaryId?: string): ContextSearchResult[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const db = getDb()
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
    content: row.content_text,
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

export function expandContextSummary(summaryId: string, offset?: number, limit?: number): ContextExpansion | null {
  const db = getDb()
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
