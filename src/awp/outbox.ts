import { randomUUID } from "crypto"
import { AGENT_ID } from "../agent-config"
import { getDb } from "../db"
import type { WorkerEvent, WorkerEventType } from "./types"

type WorkerEventListener = (event: WorkerEvent) => void

const listeners = new Set<WorkerEventListener>()
let tableReady = false
let warnedUnavailable = false

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
    ensureTable()
    const result = getDb()
      .prepare("insert into worker_events (id, agent_id, type, payload, created_at) values (?, ?, ?, ?, ?)")
      .run(id, AGENT_ID, type, JSON.stringify(payload), createdAt)
    event = {
      ...event,
      seq: Number(result.lastInsertRowid),
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
