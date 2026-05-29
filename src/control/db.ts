import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { NIRI_HOME } from "../agent-config"

const CONTROL_DB_PATH = path.resolve(process.env.NIRI_CONTROL_DB ?? path.join(NIRI_HOME, "control.db"))

let db: Database.Database

export type AgentRecord = {
  id: string
  name: string
  baseUrl: string
  token?: string
  status: string
  lastSeenAt?: string
  lastSeq: number
}

type AgentRow = {
  id: string
  name: string
  base_url: string
  token: string | null
  status: string
  last_seen_at: string | null
  last_seq: number
}

function agentFromRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    ...(row.token ? { token: row.token } : {}),
    status: row.status,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    lastSeq: row.last_seq,
  }
}

export function initControlDb(): void {
  fs.mkdirSync(path.dirname(CONTROL_DB_PATH), { recursive: true })
  db = new Database(CONTROL_DB_PATH)
  db.pragma("journal_mode = WAL")
  db.exec(`
    create table if not exists agents (
      id           text primary key,
      name         text not null,
      base_url     text not null,
      token        text,
      status       text not null default 'unknown',
      last_seen_at text,
      last_seq     integer not null default 0,
      created_at   text not null default (datetime('now')),
      updated_at   text not null default (datetime('now'))
    );

    create table if not exists worker_events (
      agent_id   text    not null,
      seq        integer not null,
      id         text    not null,
      type       text    not null,
      payload    text    not null,
      created_at text    not null,
      received_at text   not null,
      primary key (agent_id, seq)
    );

    create unique index if not exists idx_worker_events_id
      on worker_events(agent_id, id);
    create index if not exists idx_worker_events_type
      on worker_events(type, received_at desc);
  `)
  console.log(`[control] db ready at ${CONTROL_DB_PATH}`)
}

export function upsertAgent(input: {
  id: string
  name?: string
  baseUrl: string
  token?: string
}): AgentRecord {
  const id = input.id.trim()
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "")
  if (!id) throw new Error("agent id is required")
  if (!baseUrl) throw new Error("agent baseUrl is required")

  const name = input.name?.trim() || id
  db.prepare(
    `insert into agents (id, name, base_url, token, status, updated_at)
     values (?, ?, ?, ?, 'unknown', ?)
     on conflict(id) do update set
       name = excluded.name,
       base_url = excluded.base_url,
       token = excluded.token,
       updated_at = excluded.updated_at`,
  ).run(id, name, baseUrl, input.token?.trim() || null, new Date().toISOString())

  return getAgent(id)!
}

export function listAgents(): AgentRecord[] {
  const rows = db
    .prepare("select id, name, base_url, token, status, last_seen_at, last_seq from agents order by id asc")
    .all() as AgentRow[]
  return rows.map(agentFromRow)
}

export function getAgent(id: string): AgentRecord | null {
  const row = db
    .prepare("select id, name, base_url, token, status, last_seen_at, last_seq from agents where id = ?")
    .get(id) as AgentRow | undefined
  return row ? agentFromRow(row) : null
}

export function updateAgentStatus(id: string, status: string, lastSeq?: number): void {
  const now = new Date().toISOString()
  db.prepare(
    `update agents
     set status = ?,
         last_seen_at = ?,
         last_seq = max(last_seq, ?),
         updated_at = ?
     where id = ?`,
  ).run(status, now, Math.max(0, Math.trunc(lastSeq ?? 0)), now, id)
}

export function recordWorkerEvent(event: {
  agentId: string
  seq: number
  id: string
  type: string
  payload: unknown
  createdAt: string
}): void {
  const receivedAt = new Date().toISOString()
  db.prepare(
    `insert or ignore into worker_events (agent_id, seq, id, type, payload, created_at, received_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.agentId, event.seq, event.id, event.type, JSON.stringify(event.payload), event.createdAt, receivedAt)
  updateAgentStatus(event.agentId, "online", event.seq)
}

export function listMirroredEvents(agentId: string, afterSeq = 0, limit = 500, mode: "after" | "tail" = "after"): unknown[] {
  const cappedLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 500))
  const rows =
    mode === "tail"
      ? db
          .prepare(
            `select agent_id, seq, id, type, payload, created_at
             from worker_events
             where agent_id = ?
             order by seq desc
             limit ?`,
          )
          .all(agentId, cappedLimit)
          .reverse()
      : db
          .prepare(
            `select agent_id, seq, id, type, payload, created_at
             from worker_events
             where agent_id = ? and seq > ?
             order by seq asc
             limit ?`,
          )
          .all(agentId, Math.max(0, Math.trunc(afterSeq) || 0), cappedLimit)

  return (rows as Array<{
    agent_id: string
    seq: number
    id: string
    type: string
    payload: string
    created_at: string
  }>).map((row) => {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = row.payload
    }
    return {
      agentId: row.agent_id,
      seq: row.seq,
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      payload,
    }
  })
}

export type MirroredCompaction = {
  agentId: string
  seq: number
  eventId: string
  metricId?: number
  timestamp: string
  method?: string
  before?: number
  after?: number
  savedTokens?: number
  summary?: string
}

export function listRecentCompactions(agentId: string, limit = 20): MirroredCompaction[] {
  const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20))
  const rows = db
    .prepare(
      `select agent_id, seq, id, payload, created_at
       from worker_events
       where agent_id = ? and type = 'metric.recorded'
       order by seq desc
       limit 500`,
    )
    .all(agentId) as Array<{
    agent_id: string
    seq: number
    id: string
    payload: string
    created_at: string
  }>

  const compactions: MirroredCompaction[] = []
  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload.type !== "compaction") continue

    const before = typeof payload.before === "number" ? payload.before : undefined
    const after = typeof payload.after === "number" ? payload.after : undefined
    compactions.push({
      agentId: row.agent_id,
      seq: row.seq,
      eventId: row.id,
      metricId: typeof payload.id === "number" ? payload.id : undefined,
      timestamp: typeof payload.timestamp === "string" ? payload.timestamp : row.created_at,
      method: typeof payload.method === "string" ? payload.method : undefined,
      before,
      after,
      savedTokens: before !== undefined && after !== undefined ? before - after : undefined,
      summary: typeof payload.summary === "string" ? payload.summary : undefined,
    })
    if (compactions.length >= cappedLimit) break
  }

  return compactions
}
