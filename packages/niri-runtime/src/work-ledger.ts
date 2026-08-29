import { randomUUID } from "node:crypto"
import { getDb } from "./db"

export type WorkStatus = "active" | "paused" | "completed" | "cancelled"
export type CurrentWorkStatus = Extract<WorkStatus, "active" | "paused">
export type WorkItem = {
  id: string
  title: string
  note: string
  status: WorkStatus
  createdAt: string
  updatedAt: string
  closedAt: string | null
}
export type WorkItemSummary = Pick<WorkItem, "id" | "title" | "status" | "updatedAt"> & {
  notePreview: string
  noteTruncated: boolean
}

const MAX_TITLE = 160
const MAX_NOTE = 2_000
const MAX_LIST = 50

export class WorkLedgerError extends Error {
  readonly code = "invalid_argument" as const
  constructor(message: string) {
    super(message)
    this.name = "WorkLedgerError"
  }
}

type WorkRow = {
  id: string
  title: string
  note: string
  status: WorkStatus
  created_at: string
  updated_at: string
  closed_at: string | null
}

function itemFromRow(row: WorkRow): WorkItem {
  return { id: row.id, title: row.title, note: row.note, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at }
}

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  const chars = Array.from(value)
  return chars.length > limit ? { text: chars.slice(0, limit).join(""), truncated: true } : { text: value, truncated: false }
}

function compactPresentation(value: string): string {
  return value.replace(/[\s\0-\x1F\x7F]+/gu, " ").trim()
}

function title(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string") throw new WorkLedgerError("title must be a string")
  const normalized = value.trim().replace(/\s+/gu, " ")
  if (!normalized) throw new WorkLedgerError("title is required")
  if (normalized.length > MAX_TITLE) throw new WorkLedgerError(`title exceeds ${MAX_TITLE} characters`)
  return normalized
}

function note(value: unknown, supplied: boolean): string | undefined {
  if (!supplied) return undefined
  if (typeof value !== "string") throw new WorkLedgerError("note must be a string")
  const normalized = value.trim()
  if (normalized.length > MAX_NOTE) throw new WorkLedgerError(`note exceeds ${MAX_NOTE} characters`)
  return normalized
}

function id(value: unknown): string {
  if (typeof value !== "string") throw new WorkLedgerError("id must be a work item id")
  const normalized = value.trim()
  if (!normalized || !normalized.startsWith("work_")) throw new WorkLedgerError("id must be a work item id")
  return normalized
}

function currentStatus(value: unknown): CurrentWorkStatus {
  if (value === "active" || value === "paused") return value
  throw new WorkLedgerError("status must be active or paused")
}

function closeStatus(value: unknown): Extract<WorkStatus, "completed" | "cancelled"> {
  if (value === "completed" || value === "cancelled") return value
  throw new WorkLedgerError("status must be completed or cancelled")
}

function getRow(workId: string): WorkItem | null {
  const row = getDb().prepare("select * from work_items where id = ?").get(workId) as WorkRow | undefined
  return row ? itemFromRow(row) : null
}

export function createWorkItem(input: { title: unknown; note?: unknown }): WorkItem {
  const now = new Date().toISOString()
  const item: WorkItem = {
    id: `work_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    title: title(input.title, true)!,
    note: note(input.note, "note" in input) ?? "",
    status: "active",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  }
  getDb().prepare("insert into work_items (id, title, note, status, created_at, updated_at, closed_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(item.id, item.title, item.note, item.status, item.createdAt, item.updatedAt, item.closedAt)
  return item
}

export function getWorkItem(value: unknown): WorkItem | null {
  return getRow(id(value))
}

export function listWorkItems(input: { status?: unknown; limit?: unknown } = {}): WorkItemSummary[] {
  const status = input.status === undefined || input.status === null ? "current" : input.status
  if (status !== "current" && status !== "all" && status !== "active" && status !== "paused" && status !== "completed" && status !== "cancelled") {
    throw new WorkLedgerError("status must be active, paused, completed, cancelled, or all")
  }
  const limit = input.limit === undefined || input.limit === null ? 20 : input.limit
  if (typeof limit !== "number" || !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
    throw new WorkLedgerError(`limit must be an integer from 1 to ${MAX_LIST}`)
  }
  const where = status === "current" ? "where status in ('active', 'paused')" : status === "all" ? "" : "where status = ?"
  const order = status === "current" ? "order by case status when 'active' then 0 else 1 end, updated_at desc, id desc" : "order by updated_at desc, id desc"
  const values = status === "active" || status === "paused" || status === "completed" || status === "cancelled" ? [status, limit] : [limit]
  const rows = getDb().prepare(`select * from work_items ${where} ${order} limit ?`).all(...values) as WorkRow[]
  return rows.map((row) => {
    const preview = truncate(compactPresentation(row.note), 400)
    return { id: row.id, title: row.title, status: row.status, updatedAt: row.updated_at, notePreview: preview.text, noteTruncated: preview.truncated }
  })
}

export function updateWorkItem(input: { id: unknown; title?: unknown; note?: unknown; status?: unknown }): WorkItem {
  const workId = id(input.id)
  const fields: string[] = []
  const values: unknown[] = []
  if ("title" in input) { fields.push("title = ?"); values.push(title(input.title, false)) }
  if ("note" in input) { fields.push("note = ?"); values.push(note(input.note, true)) }
  if ("status" in input) { fields.push("status = ?"); values.push(currentStatus(input.status)) }
  if (!fields.length) throw new WorkLedgerError("at least one of title, note, or status is required")
  const now = new Date().toISOString()
  const result = getDb().prepare(`update work_items set ${fields.join(", ")}, updated_at = ? where id = ? and status in ('active', 'paused')`).run(...values, now, workId)
  if (!result.changes) {
    const existing = getRow(workId)
    if (!existing) throw new WorkLedgerError("unknown work item")
    throw new WorkLedgerError("work item is already closed")
  }
  return getRow(workId)!
}

export function closeWorkItem(input: { id: unknown; status: unknown }): WorkItem {
  const workId = id(input.id)
  const status = closeStatus(input.status)
  const now = new Date().toISOString()
  const result = getDb().prepare("update work_items set status = ?, updated_at = ?, closed_at = ? where id = ? and status in ('active', 'paused')").run(status, now, now, workId)
  if (!result.changes) {
    const existing = getRow(workId)
    if (!existing) throw new WorkLedgerError("unknown work item")
    throw new WorkLedgerError("work item is already closed")
  }
  return getRow(workId)!
}

export function formatCurrentWorkForWake(): string | null {
  const rows = getDb().prepare("select * from work_items where status in ('active', 'paused') order by case status when 'active' then 0 else 1 end, updated_at desc, id desc limit 9").all() as WorkRow[]
  if (!rows.length) return null
  const lines = ["[current work ledger — durable state]"]
  const more = "- … more current items; use work list."
  let omitted = rows.length > 8
  for (const row of rows.slice(0, 8)) {
    const preview = truncate(compactPresentation(row.note), 180).text
    const line = `- [${row.status}] ${row.id} — ${compactPresentation(row.title)}${preview ? ` — ${preview}` : ""}`
    // Reserve the omission line. A later row must never crowd it out.
    if (Array.from([...lines, line, more].join("\n")).length > 2_000) { omitted = true; break }
    lines.push(line)
  }
  if (omitted) lines.push(more)
  return lines.join("\n")
}
