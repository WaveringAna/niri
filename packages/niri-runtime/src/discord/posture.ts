import {
  getDiscordMeta,
  holdPendingDiscordItems,
  queryPostureQueue,
  setDiscordMeta,
  type PostureQueueRow,
} from "./db"

export type Posture = "hearth" | "forge"

export const POSTURE_DEFINITIONS: Record<Posture, { status: Posture; bio: string }> = {
  hearth: {
    status: "hearth",
    bio: "violet light, warm and steady. i'm around — say hi.",
  },
  forge: {
    status: "forge",
    bio: "building and tending to something. your messages are safe — i'll find them when i come back.",
  },
}

const POSTURE_KEY = "posture"
const POSTURE_STARTED_AT_KEY = "posture_started_at"
const POSTURE_REMINDER_SENT_KEY = "posture_reminder_sent_at"
const POSTURE_REMINDER_MS = 2 * 60 * 60 * 1000

type PostureListener = (posture: Posture) => void
type ReminderListener = (message: string) => void

const listeners = new Set<PostureListener>()
let reminderTimer: ReturnType<typeof setTimeout> | null = null
let reminderListener: ReminderListener | null = null

function isPosture(value: string | null): value is Posture {
  return value === "hearth" || value === "forge"
}

function configuredPostureBypass(): { users: Set<string>; channels: Set<string> } {
  const raw = process.env.DISCORD_POSTURE_BYPASS?.trim()
  if (!raw) return { users: new Set(), channels: new Set() }

  try {
    const value = JSON.parse(raw) as { users?: unknown; channels?: unknown }
    const ids = (input: unknown): Set<string> =>
      new Set(Array.isArray(input) ? input.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [])
    return { users: ids(value.users), channels: ids(value.channels) }
  } catch (err) {
    console.warn(`[posture] invalid DISCORD_POSTURE_BYPASS: ${err instanceof Error ? err.message : String(err)}`)
    return { users: new Set(), channels: new Set() }
  }
}

export function getPosture(): Posture {
  const value = getDiscordMeta(POSTURE_KEY)
  return isPosture(value) ? value : "hearth"
}

function getPostureStartedAt(): string | null {
  if (getPosture() !== "forge") return null
  const current = getDiscordMeta(POSTURE_STARTED_AT_KEY)
  if (current && Number.isFinite(Date.parse(current))) return current
  const startedAt = new Date().toISOString()
  setDiscordMeta(POSTURE_STARTED_AT_KEY, startedAt)
  return startedAt
}

export function isPostureBypass(authorId?: string | null, channelId?: string | null): boolean {
  const configured = configuredPostureBypass()
  return Boolean(
    (authorId && configured.users.has(authorId.trim())) ||
      (channelId && configured.channels.has(channelId.trim())),
  )
}

export function subscribePosture(listener: PostureListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyPosture(posture: Posture): void {
  for (const listener of listeners) {
    try {
      listener(posture)
    } catch (err) {
      console.warn(`[posture] listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function queuePersonLabel(row: PostureQueueRow): string {
  return `@${row.author_username?.trim() || row.author_id?.trim() || "unknown"}`
}

export function formatPostureQueue(rows = queryPostureQueue()): string {
  const dmRows = rows.filter((row) => row.is_dm === 1)
  const channelRows = rows.filter((row) => row.is_dm !== 1)
  const lines: string[] = []

  if (dmRows.length > 0) {
    lines.push("these people DM'd you")
    for (const row of dmRows) {
      lines.push(`${queuePersonLabel(row)}: ${row.count} ${row.count === 1 ? "message" : "messages"}`)
    }
  }

  if (channelRows.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push("these channel messages are waiting")
    for (const row of channelRows) {
      const channel = row.channel_name?.trim() || row.channel_id
      lines.push(`${queuePersonLabel(row)} in #${channel}: ${row.count} ${row.count === 1 ? "message" : "messages"}`)
    }
  }

  return lines.length > 0 ? lines.join("\n") : "nobody's waiting, keep going"
}

export function buildPostureReminder(): string {
  return `you've been in forge for 2 hours, check your queue?\n\n${formatPostureQueue()}`
}

function clearPostureReminderTimer(): void {
  if (reminderTimer) clearTimeout(reminderTimer)
  reminderTimer = null
}

function schedulePostureReminder(): void {
  clearPostureReminderTimer()
  if (!reminderListener || getPosture() !== "forge") return

  const startedAt = getPostureStartedAt()
  if (!startedAt || getDiscordMeta(POSTURE_REMINDER_SENT_KEY) === startedAt) return
  const dueAt = Date.parse(startedAt) + POSTURE_REMINDER_MS
  const delay = Math.max(0, dueAt - Date.now())
  reminderTimer = setTimeout(() => {
    reminderTimer = null
    if (getPosture() !== "forge") return
    const currentStartedAt = getPostureStartedAt()
    if (!currentStartedAt || getDiscordMeta(POSTURE_REMINDER_SENT_KEY) === currentStartedAt) return
    setDiscordMeta(POSTURE_REMINDER_SENT_KEY, currentStartedAt)
    reminderListener?.(buildPostureReminder())
  }, delay)
  reminderTimer.unref?.()
}

export function startPostureReminder(listener: ReminderListener): () => void {
  reminderListener = listener
  schedulePostureReminder()
  return () => {
    clearPostureReminderTimer()
    if (reminderListener === listener) reminderListener = null
  }
}

export type PostureState = {
  posture: Posture
  started_at: string | null
  queued: number
  queue: string
}

export function getPostureState(): PostureState {
  const rows = queryPostureQueue()
  return {
    posture: getPosture(),
    started_at: getPostureStartedAt(),
    queued: rows.reduce((total, row) => total + row.count, 0),
    queue: formatPostureQueue(rows),
  }
}

export type PostureChange = PostureState & {
  changed: boolean
  previous: Posture
  held: number
}

export function setPosture(next: Posture): PostureChange {
  const previous = getPosture()
  if (previous === next) {
    return { ...getPostureState(), changed: false, previous, held: 0 }
  }

  const held = next === "forge" ? holdPendingDiscordItems() : 0
  setDiscordMeta(POSTURE_KEY, next)
  if (next === "forge") {
    setDiscordMeta(POSTURE_STARTED_AT_KEY, new Date().toISOString())
    setDiscordMeta(POSTURE_REMINDER_SENT_KEY, "")
  } else {
    setDiscordMeta(POSTURE_REMINDER_SENT_KEY, "")
  }

  notifyPosture(next)
  schedulePostureReminder()
  return { ...getPostureState(), changed: true, previous, held }
}
