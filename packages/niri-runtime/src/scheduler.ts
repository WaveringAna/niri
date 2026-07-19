import { randomUUID } from "node:crypto"
import { getDb } from "./db"
import { enqueueEvent, isRunning, isShuttingDown, wake } from "./runner/index"
import type { UserMessage } from "./types"

const TICK_INTERVAL_MS = 15_000
const MAX_MESSAGE_LENGTH = 2_000
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000
const MIN_REPEAT_MS = 60_000

export type Schedule = {
  id: string
  message: string
  fire_at: string
  repeat_every_ms: number | null
  status: "pending" | "fired" | "cancelled"
  created_at: string
  fired_at: string | null
}

let tableReady = false

function ensureTable(): void {
  if (tableReady) return
  getDb().exec(`
    create table if not exists schedules (
      id text primary key,
      message text not null,
      fire_at text not null,
      repeat_every_ms integer,
      status text not null default 'pending' check (status in ('pending', 'fired', 'cancelled')),
      created_at text not null,
      fired_at text
    );
    create index if not exists idx_schedules_due on schedules(status, fire_at);
  `)
  tableReady = true
}

function decodeSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    message: String(row.message),
    fire_at: String(row.fire_at),
    repeat_every_ms: typeof row.repeat_every_ms === "number" ? row.repeat_every_ms : null,
    status: row.status as Schedule["status"],
    created_at: String(row.created_at),
    fired_at: typeof row.fired_at === "string" ? row.fired_at : null,
  }
}

/**
 * Creates a pending schedule. Exactly one of `at` (ISO 8601 timestamp) or
 * `delayMs` must place it in the future; `repeatEveryMs` re-fires it on that
 * interval until cancelled.
 */
export function createSchedule(input: {
  message: unknown
  at?: unknown
  delayMs?: unknown
  repeatEveryMs?: unknown
}): Schedule {
  ensureTable()
  const message = String(input.message ?? "").trim()
  if (!message) throw new Error("message is required")
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`message exceeds ${MAX_MESSAGE_LENGTH} characters`)

  const at = typeof input.at === "string" && input.at.trim() ? input.at.trim() : undefined
  const delayMs = typeof input.delayMs === "number" && Number.isFinite(input.delayMs) ? Math.trunc(input.delayMs) : undefined
  if ((at === undefined) === (delayMs === undefined)) {
    throw new Error("exactly one of at or delay_ms is required")
  }

  let fireAtMs: number
  if (at !== undefined) {
    fireAtMs = Date.parse(at)
    if (!Number.isFinite(fireAtMs)) throw new Error(`invalid at timestamp: ${at}`)
  } else {
    if (delayMs! < 1_000) throw new Error("delay_ms must be at least 1000")
    if (delayMs! > MAX_DELAY_MS) throw new Error(`delay_ms must be at most ${MAX_DELAY_MS} (about one year)`)
    fireAtMs = Date.now() + delayMs!
  }

  const repeatEveryMs =
    typeof input.repeatEveryMs === "number" && Number.isFinite(input.repeatEveryMs) ? Math.trunc(input.repeatEveryMs) : null
  if (repeatEveryMs !== null && repeatEveryMs < MIN_REPEAT_MS) {
    throw new Error(`repeat_every_ms must be at least ${MIN_REPEAT_MS} (one minute)`)
  }

  const schedule: Schedule = {
    id: `sch_${randomUUID()}`,
    message,
    fire_at: new Date(fireAtMs).toISOString(),
    repeat_every_ms: repeatEveryMs,
    status: "pending",
    created_at: new Date().toISOString(),
    fired_at: null,
  }
  getDb()
    .prepare(
      "insert into schedules (id, message, fire_at, repeat_every_ms, status, created_at) values (?, ?, ?, ?, 'pending', ?)",
    )
    .run(schedule.id, schedule.message, schedule.fire_at, schedule.repeat_every_ms, schedule.created_at)
  return schedule
}

/** Lists pending schedules, soonest first. */
export function listSchedules(limit = 50): Schedule[] {
  ensureTable()
  const rows = getDb()
    .prepare("select * from schedules where status = 'pending' order by fire_at asc limit ?")
    .all(Math.max(1, Math.min(200, Math.trunc(limit) || 50))) as Array<Record<string, unknown>>
  return rows.map(decodeSchedule)
}

/** Cancels a pending schedule. Returns false when no pending schedule matches. */
export function cancelSchedule(id: unknown): boolean {
  ensureTable()
  const scheduleId = String(id ?? "").trim()
  if (!scheduleId) throw new Error("id is required")
  const result = getDb().prepare("update schedules set status = 'cancelled' where id = ? and status = 'pending'").run(scheduleId)
  return result.changes > 0
}

function scheduleToEvent(schedule: Schedule): UserMessage {
  return {
    source: "cron",
    triggeredAt: new Date().toISOString(),
    content: `[scheduled reminder ${schedule.id}] ${schedule.message}`,
    raw: { type: "schedule", id: schedule.id, message: schedule.message, repeat_every_ms: schedule.repeat_every_ms },
  }
}

type ScheduleDispatch = (event: UserMessage) => boolean

function defaultDispatch(event: UserMessage): boolean {
  // Never consume a schedule while shutting down: dispatch would be dropped
  // and the row update would silently eat the reminder. Leave it pending so
  // the next boot's fireDueSchedules delivers it instead.
  if (isShuttingDown()) return false
  // Mirror server.ts dispatchEvent: deliver into the active session, or start
  // one when idle — never both, or the reminder would arrive twice.
  return isRunning() ? enqueueEvent(event) : (void wake(event), true)
}

function fireSchedule(schedule: Schedule, dispatch: ScheduleDispatch): void {
  if (!dispatch(scheduleToEvent(schedule))) return

  if (schedule.repeat_every_ms === null) {
    getDb()
      .prepare("update schedules set status = 'fired', fired_at = ? where id = ?")
      .run(new Date().toISOString(), schedule.id)
    return
  }
  // Catch up to the next future occurrence so a downtime does not burst-fire.
  let nextMs = Date.parse(schedule.fire_at) + schedule.repeat_every_ms
  const nowMs = Date.now()
  while (nextMs <= nowMs) nextMs += schedule.repeat_every_ms
  getDb().prepare("update schedules set fire_at = ? where id = ?").run(new Date(nextMs).toISOString(), schedule.id)
}

function fireDueSchedules(dispatch: ScheduleDispatch = defaultDispatch): void {
  ensureTable()
  const now = new Date().toISOString()
  const due = getDb()
    .prepare("select * from schedules where status = 'pending' and fire_at <= ? order by fire_at asc limit 25")
    .all(now) as Array<Record<string, unknown>>
  for (const row of due) {
    try {
      fireSchedule(decodeSchedule(row), dispatch)
    } catch (error) {
      console.warn(`[scheduler] failed to fire ${row.id}:`, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * Starts the schedule dispatcher. Due schedules (including ones missed while
 * the worker was down) fire on start and then every tick. Returns a stop
 * function for graceful shutdown.
 */
export function startScheduler(): () => void {
  fireDueSchedules()
  const timer = setInterval(() => {
    try {
      fireDueSchedules()
    } catch (error) {
      console.warn("[scheduler] tick failed:", error instanceof Error ? error.message : String(error))
    }
  }, TICK_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export const __schedulerTest = { ensureTable, scheduleToEvent, fireDueSchedules, defaultDispatch }
