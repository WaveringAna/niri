import { randomUUID } from "crypto"
import { AGENT_ID } from "../agent-config"
import { getDb } from "../db"
import type { WorkerEvent, WorkerEventType } from "./types"

type WorkerEventListener = (event: WorkerEvent) => void

const listeners = new Set<WorkerEventListener>()
const DEFAULT_REPLAY_TAIL_ROWS = 5000
const PRUNE_EVERY_PERSISTED_EVENTS = 100
let tableReady = false
let warnedUnavailable = false
let persistedSincePrune = 0

function replayTailRows(): number {
  const parsed = Number(process.env.AWP_REPLAY_TAIL_ROWS ?? DEFAULT_REPLAY_TAIL_ROWS)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REPLAY_TAIL_ROWS
  return Math.trunc(parsed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function shouldPersistWorkerEvent(type: WorkerEventType, payload: unknown): boolean {
  if (type === "worker.heartbeat") return false

  if (type === "metric.recorded") {
    return isRecord(payload) && payload.type === "compaction"
  }

  if (type === "stream.event") {
    if (!isRecord(payload)) return false
    return payload.type === "user" || payload.type === "usage"
  }

  return true
}

function pruneWorkerEvents(): void {
  const tailRows = replayTailRows()
  if (tailRows <= 0) {
    getDb().prepare("delete from worker_events").run()
    return
  }

  const row = getDb().prepare("select coalesce(max(seq), 0) as seq from worker_events").get() as { seq?: number }
  const cutoff = Math.max(0, Math.trunc(row.seq ?? 0) - tailRows)
  if (cutoff <= 0) return

  getDb().prepare("delete from worker_events where seq <= ?").run(cutoff)
}

function ensureTable(): void {
  if (tableReady) return

  getDb().exec(`
    create table if not exists worker_events (
      seq        integer primary key autoincrement,
      id         text    not null unique,
      agent_id   text    not null,
      type       text    not null,
      payload    text    not null,
      created_at text    not null
    );

    create index if not exists idx_worker_events_agent_seq
      on worker_events(agent_id, seq);
  `)

  tableReady = true
}

function decodeWorkerEvent(row: {
  seq: number
  id: string
  agent_id: string
  type: string
  payload: string
  created_at: string
}): WorkerEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = row.payload
  }

  return {
    id: row.id,
    agentId: row.agent_id,
    seq: row.seq,
    type: row.type as WorkerEventType,
    createdAt: row.created_at,
    payload,
  }
}

export function publishWorkerEvent(type: WorkerEventType, payload: unknown): WorkerEvent {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  let event: WorkerEvent = {
    id,
    agentId: AGENT_ID,
    seq: 0,
    type,
    createdAt,
    payload,
  }

  try {
    if (shouldPersistWorkerEvent(type, payload)) {
      ensureTable()
      const result = getDb()
        .prepare("insert into worker_events (id, agent_id, type, payload, created_at) values (?, ?, ?, ?, ?)")
        .run(id, AGENT_ID, type, JSON.stringify(payload), createdAt)
      event = {
        ...event,
        seq: Number(result.lastInsertRowid),
      }
      persistedSincePrune += 1
      if (persistedSincePrune >= PRUNE_EVERY_PERSISTED_EVENTS) {
        persistedSincePrune = 0
        pruneWorkerEvents()
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== "Database not initialized" && !warnedUnavailable) {
      warnedUnavailable = true
      console.warn(`[awp] worker event outbox unavailable: ${message}`)
    }
  }

  for (const listener of listeners) listener(event)
  return event
}

export function listWorkerEvents(afterSeq = 0, limit = 500, mode: "after" | "tail" = "after"): WorkerEvent[] {
  ensureTable()
  const cappedLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 500))
  const rows =
    mode === "tail"
      ? getDb()
          .prepare(
            `select seq, id, agent_id, type, payload, created_at
             from worker_events
             order by seq desc
             limit ?`,
          )
          .all(cappedLimit)
          .reverse()
      : getDb()
          .prepare(
            `select seq, id, agent_id, type, payload, created_at
             from worker_events
             where seq > ?
             order by seq asc
             limit ?`,
          )
          .all(Math.max(0, Math.trunc(afterSeq) || 0), cappedLimit)

  return (rows as Array<{
    seq: number
    id: string
    agent_id: string
    type: string
    payload: string
    created_at: string
  }>).map(decodeWorkerEvent)
}

export function subscribeWorkerEvents(listener: WorkerEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
