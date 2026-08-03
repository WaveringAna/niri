import { randomUUID } from "node:crypto"
import { getDb } from "../db"

export type DelegatedTaskStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted"
export type DelegatedMessageKind = "instruction" | "progress" | "question" | "answer" | "result" | "cancel" | "system"
export type DelegatedSenderKind = "niri" | "subagent" | "discord-user" | "system"

export type DelegatedTask = {
  id: string
  profile: string
  objective: string
  status: DelegatedTaskStatus
  createdByKind: DelegatedSenderKind
  createdById: string | null
  createdByName: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  resultSummary: string | null
  error: string | null
  discordThreadId: string | null
  cancelRequested: boolean
  tokenCount: number
  contextSize: number
}

export type DelegatedTaskMessage = {
  id: string
  taskId: string
  seq: number
  senderKind: DelegatedSenderKind
  senderId: string | null
  senderName: string
  kind: DelegatedMessageKind
  content: string
  createdAt: string
  discordMessageId: string | null
}

type TaskRow = {
  id: string
  profile: string
  objective: string
  status: DelegatedTaskStatus
  created_by_kind: DelegatedSenderKind
  created_by_id: string | null
  created_by_name: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  result_summary: string | null
  error: string | null
  discord_thread_id: string | null
  cancel_requested: number
  token_count: number
  context_size: number
}

type MessageRow = {
  id: string
  task_id: string
  seq: number
  sender_kind: DelegatedSenderKind
  sender_id: string | null
  sender_name: string
  kind: DelegatedMessageKind
  content: string
  created_at: string
  discord_message_id: string | null
}

function taskFromRow(row: TaskRow): DelegatedTask {
  return {
    id: row.id,
    profile: row.profile,
    objective: row.objective,
    status: row.status,
    createdByKind: row.created_by_kind,
    createdById: row.created_by_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultSummary: row.result_summary,
    error: row.error,
    discordThreadId: row.discord_thread_id,
    cancelRequested: row.cancel_requested === 1,
    tokenCount: row.token_count,
    contextSize: row.context_size,
  }
}

function messageFromRow(row: MessageRow): DelegatedTaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    senderKind: row.sender_kind,
    senderId: row.sender_id,
    senderName: row.sender_name,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    discordMessageId: row.discord_message_id,
  }
}

export function createDelegatedTask(input: {
  profile: string
  objective: string
  senderKind?: DelegatedSenderKind
  senderId?: string
  senderName?: string
}): DelegatedTask {
  const now = new Date().toISOString()
  const task: DelegatedTask = {
    id: `task_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    profile: input.profile,
    objective: input.objective,
    status: "queued",
    createdByKind: input.senderKind ?? "niri",
    createdById: input.senderId ?? null,
    createdByName: input.senderName ?? "niri",
    createdAt: now,
    startedAt: null,
    completedAt: null,
    resultSummary: null,
    error: null,
    discordThreadId: null,
    cancelRequested: false,
    tokenCount: 0,
    contextSize: 0,
  }
  getDb().prepare(`
    insert into delegated_tasks (
      id, profile, objective, status, created_by_kind, created_by_id, created_by_name, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.id, task.profile, task.objective, task.status, task.createdByKind, task.createdById, task.createdByName, task.createdAt)
  return task
}

export function getDelegatedTask(id: string): DelegatedTask | null {
  const row = getDb().prepare("select * from delegated_tasks where id = ?").get(id) as TaskRow | undefined
  return row ? taskFromRow(row) : null
}

export function getDelegatedTaskByThread(threadId: string): DelegatedTask | null {
  const row = getDb().prepare("select * from delegated_tasks where discord_thread_id = ?").get(threadId) as TaskRow | undefined
  return row ? taskFromRow(row) : null
}

export function listDelegatedTasks(limit = 20): DelegatedTask[] {
  const capped = Math.max(1, Math.min(100, Math.trunc(limit) || 20))
  return (getDb().prepare("select * from delegated_tasks order by created_at desc limit ?").all(capped) as TaskRow[]).map(taskFromRow)
}

export function listQueuedDelegatedTasks(): DelegatedTask[] {
  return (getDb().prepare("select * from delegated_tasks where status = 'queued' order by created_at").all() as TaskRow[]).map(taskFromRow)
}

export function updateDelegatedTask(id: string, patch: {
  status?: DelegatedTaskStatus
  startedAt?: string | null
  completedAt?: string | null
  resultSummary?: string | null
  error?: string | null
  discordThreadId?: string | null
  cancelRequested?: boolean
  tokenCount?: number
  contextSize?: number
}): DelegatedTask | null {
  const columns: string[] = []
  const values: unknown[] = []
  const entries: Array<[keyof typeof patch, string, (value: unknown) => unknown]> = [
    ["status", "status", (value) => value],
    ["startedAt", "started_at", (value) => value],
    ["completedAt", "completed_at", (value) => value],
    ["resultSummary", "result_summary", (value) => value],
    ["error", "error", (value) => value],
    ["discordThreadId", "discord_thread_id", (value) => value],
    ["cancelRequested", "cancel_requested", (value) => value ? 1 : 0],
    ["tokenCount", "token_count", (value) => value],
    ["contextSize", "context_size", (value) => value],
  ]
  for (const [key, column, convert] of entries) {
    if (!(key in patch)) continue
    columns.push(`${column} = ?`)
    values.push(convert(patch[key]))
  }
  if (columns.length === 0) return getDelegatedTask(id)
  getDb().prepare(`update delegated_tasks set ${columns.join(", ")} where id = ?`).run(...values, id)
  return getDelegatedTask(id)
}

export function interruptActiveDelegatedTasks(): number {
  const now = new Date().toISOString()
  return getDb().prepare(`
    update delegated_tasks
    set status = 'interrupted', completed_at = ?, error = 'runtime restarted before task completion'
    where status in ('running', 'needs_input')
  `).run(now).changes
}

export function appendDelegatedTaskMessage(input: {
  taskId: string
  senderKind: DelegatedSenderKind
  senderId?: string
  senderName: string
  kind: DelegatedMessageKind
  content: string
  discordMessageId?: string
}): DelegatedTaskMessage {
  const db = getDb()
  const insert = db.transaction(() => {
    const seqRow = db.prepare("select coalesce(max(seq), 0) + 1 as seq from delegated_task_messages where task_id = ?").get(input.taskId) as { seq: number }
    const message: DelegatedTaskMessage = {
      id: `taskmsg_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      taskId: input.taskId,
      seq: seqRow.seq,
      senderKind: input.senderKind,
      senderId: input.senderId ?? null,
      senderName: input.senderName,
      kind: input.kind,
      content: input.content,
      createdAt: new Date().toISOString(),
      discordMessageId: input.discordMessageId ?? null,
    }
    db.prepare(`
      insert into delegated_task_messages (
        id, task_id, seq, sender_kind, sender_id, sender_name, kind, content, created_at, discord_message_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.taskId, message.seq, message.senderKind, message.senderId, message.senderName, message.kind, message.content, message.createdAt, message.discordMessageId)
    return message
  })
  return insert()
}

export function listDelegatedTaskMessages(taskId: string, options: { afterSeq?: number; limit?: number } = {}): DelegatedTaskMessage[] {
  const afterSeq = Math.max(0, Math.trunc(options.afterSeq ?? 0) || 0)
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50) || 50))
  return (getDb().prepare(`
    select * from delegated_task_messages
    where task_id = ? and seq > ?
    order by seq
    limit ?
  `).all(taskId, afterSeq, limit) as MessageRow[]).map(messageFromRow)
}
