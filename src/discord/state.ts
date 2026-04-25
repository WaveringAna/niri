import { REST, Routes } from "discord.js"
import { getDb } from "../db.js"

type InboxStatus = "pending" | "seen" | "acted" | "ignored"
type InboxAction = "none" | "replied" | "messaged" | "dismissed" | "noted"
type ReplyMode = "auto" | "plain" | "explicit"

type DiscordObject = Record<string, unknown>

type DiscordMessageRecord = {
  messageId: string
  channelId: string
  guildId: string | null
  channelType: number | null
  authorId: string | null
  authorUsername: string | null
  content: string
  createdAt: string
  isDm: boolean
  isFromBot: boolean
  isFromSelf: boolean
  mentionsBot: boolean
  rawJson: string
}

type DiscordChannelRecord = {
  channelId: string
  guildId: string | null
  channelType: number | null
  channelName: string | null
  guildName: string | null
  topic: string | null
  isDm: boolean
  configured: boolean
  rawJson: string
}

export type DiscordIngestResult = {
  stored: boolean
  isNew: boolean
  messageId?: string
  itemId?: string
  bucket?: "dm" | "mention"
  isFromBot?: boolean
  isFromSelf?: boolean
  reason?: string
}

export type DiscordBatchDigest = {
  content: string
  messageCount: number
  pendingCount: number
  from: string
  to: string
}

const DEFAULT_SCAN_LIMIT = 50
const AUTO_REPLY_STALE_MINUTES = 10
const DISCORD_REST_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(10, Number.parseInt(process.env.DISCORD_REST_MAX_ATTEMPTS ?? "3", 10) || 3),
)
const DISCORD_REST_RETRY_BASE_MS = Math.max(
  100,
  Math.min(30_000, Number.parseInt(process.env.DISCORD_REST_RETRY_BASE_MS ?? "1000", 10) || 1000),
)

const VALID_STATUS = new Set<InboxStatus>(["pending", "seen", "acted", "ignored"])
const VALID_ACTION = new Set<InboxAction>(["none", "replied", "messaged", "dismissed", "noted"])

function asObject(value: unknown): DiscordObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DiscordObject) : null
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes"
  }
  return false
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toIsoString(value: unknown): string {
  const raw = asString(value)
  if (!raw) return new Date().toISOString()
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

function parseChannelIds(input?: string[] | string | null): string[] {
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter(Boolean)
  }

  const text = typeof input === "string" ? input : process.env.DISCORD_SCAN_CHANNEL_IDS ?? ""
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
}

function configuredChannelIdSet(input?: string[] | string | null): Set<string> {
  return new Set(parseChannelIds(input))
}

function getBotToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required")
  return token
}

function makeRestClient(): REST {
  return new REST({ version: "10" }).setToken(getBotToken())
}

function errorCode(err: unknown): string {
  const value = err as { code?: unknown; cause?: unknown }
  if (typeof value?.code === "string") return value.code
  const cause = value?.cause as { code?: unknown } | undefined
  return typeof cause?.code === "string" ? cause.code : ""
}

function errorStatus(err: unknown): number | null {
  const value = err as { status?: unknown }
  return typeof value?.status === "number" && Number.isFinite(value.status) ? value.status : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRetryableDiscordRestError(err: unknown): boolean {
  const code = errorCode(err)
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ECONNREFUSED"
  ) {
    return true
  }

  const status = errorStatus(err)
  return status === 429 || status === 502 || status === 503 || status === 504
}

function retryDelayMs(attempt: number): number {
  return DISCORD_REST_RETRY_BASE_MS * 2 ** attempt
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withDiscordRestRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown

  for (let attempt = 0; attempt < DISCORD_REST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryableDiscordRestError(err) || attempt + 1 >= DISCORD_REST_MAX_ATTEMPTS) break

      const delayMs = retryDelayMs(attempt)
      console.warn(
        `[discord rest] ${label} failed (${errorCode(err) || errorStatus(err) || "unknown"}: ${errorMessage(err)}); retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
    }
  }

  throw lastErr
}

async function getBotUserId(rest: REST): Promise<string> {
  const me = (await withDiscordRestRetry("get current user", () => rest.get(Routes.user("@me")))) as { id?: unknown }
  const id = asString(me?.id)
  if (!id) throw new Error("failed to resolve bot user id")
  return id
}

function parseMessageRecord(payload: unknown, botUserId?: string): DiscordMessageRecord | null {
  const root = asObject(payload)
  if (!root) return null
  const botId = botUserId ?? process.env.DISCORD_BOT_USER_ID?.trim()

  const message = asObject(root.message) ?? root
  const channel = asObject(root.channel)
  const author = asObject(message.author) ?? asObject(root.author)

  const messageId = asString(message.id ?? root.message_id)
  const channelId = asString(message.channel_id ?? root.channel_id ?? channel?.id)

  if (!messageId || !channelId) return null

  const guildId = asString(message.guild_id ?? root.guild_id ?? channel?.guild_id)
  const channelType = asNumber(message.channel_type ?? root.channel_type ?? channel?.type)

  const authorId = asString(author?.id ?? root.author_id)
  const authorUsername =
    asString(author?.global_name) ?? asString(author?.username) ?? asString(root.author_username) ?? asString(root.author)

  const content = String(message.content ?? root.content ?? "")
  const createdAt = toIsoString(message.timestamp ?? root.timestamp)

  const isDm =
    asBoolean(root.is_dm) ||
    channelType === 1 ||
    channelType === 3 ||
    (guildId == null && channelType == null)
  const isFromSelf = Boolean(botId && authorId === botId)
  const isFromBot = asBoolean(author?.bot ?? root.author_is_bot) || isFromSelf

  let mentionsBot = asBoolean(root.mentions_bot)
  if (!mentionsBot && botId) {
    const mentions = Array.isArray(message.mentions) ? message.mentions : []
    mentionsBot = mentions.some((entry) => {
      const obj = asObject(entry)
      if (!obj) return false
      const mentionedId = asString(obj.id)
      if (mentionedId && mentionedId === botId) return true
      return asBoolean(obj.bot)
    })

    if (!mentionsBot && content.includes(`<@${botId}>`)) mentionsBot = true
    if (!mentionsBot && content.includes(`<@!${botId}>`)) mentionsBot = true
  }

  return {
    messageId,
    channelId,
    guildId,
    channelType,
    authorId,
    authorUsername,
    content,
    createdAt,
    isDm,
    isFromBot,
    isFromSelf,
    mentionsBot,
    rawJson: JSON.stringify(payload),
  }
}

function parseChannelRecord(
  payload: unknown,
  fallback?: { channelId?: string; guildId?: string | null; channelType?: number | null; isDm?: boolean },
): DiscordChannelRecord | null {
  const root = asObject(payload)
  if (!root) return null

  const channel = asObject(root.channel) ?? root
  const channelId = asString(channel.id ?? root.channel_id ?? fallback?.channelId)
  if (!channelId) return null

  const guildId = asString(channel.guild_id ?? root.guild_id ?? fallback?.guildId)
  const channelType = asNumber(channel.type ?? root.channel_type ?? fallback?.channelType)
  const isDm = asBoolean(root.is_dm) || channelType === 1 || channelType === 3 || fallback?.isDm === true
  const configured = configuredChannelIdSet().has(channelId)

  return {
    channelId,
    guildId,
    channelType,
    channelName: asString(channel.name ?? root.channel_name),
    guildName: asString(root.guild_name),
    topic: asString(channel.topic ?? root.channel_topic),
    isDm,
    configured,
    rawJson: JSON.stringify(channel),
  }
}

function upsertDiscordChannel(record: DiscordChannelRecord): void {
  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(
    `insert into discord_channels (
      channel_id, guild_id, channel_type, channel_name, guild_name, topic,
      is_dm, configured, first_seen_at, last_seen_at, raw_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(channel_id) do update set
      guild_id = coalesce(excluded.guild_id, discord_channels.guild_id),
      channel_type = coalesce(excluded.channel_type, discord_channels.channel_type),
      channel_name = coalesce(excluded.channel_name, discord_channels.channel_name),
      guild_name = coalesce(excluded.guild_name, discord_channels.guild_name),
      topic = coalesce(excluded.topic, discord_channels.topic),
      is_dm = excluded.is_dm,
      configured = max(discord_channels.configured, excluded.configured),
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json`,
  ).run(
    record.channelId,
    record.guildId,
    record.channelType,
    record.channelName,
    record.guildName,
    record.topic,
    record.isDm ? 1 : 0,
    record.configured ? 1 : 0,
    now,
    now,
    record.rawJson,
  )
}

function upsertDiscordMessage(record: DiscordMessageRecord): void {
  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(
    `insert into discord_messages (
      message_id, channel_id, guild_id, channel_type,
      author_id, author_username, content, created_at,
      is_dm, mentions_bot, is_from_bot,
      first_seen_at, last_seen_at, raw_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(message_id) do update set
      channel_id = excluded.channel_id,
      guild_id = coalesce(excluded.guild_id, discord_messages.guild_id),
      channel_type = coalesce(excluded.channel_type, discord_messages.channel_type),
      author_id = excluded.author_id,
      author_username = excluded.author_username,
      content = excluded.content,
      created_at = excluded.created_at,
      is_dm = case
        when excluded.guild_id is not null then 0
        when discord_messages.guild_id is not null and excluded.guild_id is null then discord_messages.is_dm
        else excluded.is_dm
      end,
      mentions_bot = excluded.mentions_bot,
      is_from_bot = excluded.is_from_bot,
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json`,
  ).run(
    record.messageId,
    record.channelId,
    record.guildId,
    record.channelType,
    record.authorId,
    record.authorUsername,
    record.content,
    record.createdAt,
    record.isDm ? 1 : 0,
    record.mentionsBot ? 1 : 0,
    record.isFromBot ? 1 : 0,
    now,
    now,
    record.rawJson,
  )
}

function upsertInboxItem(messageId: string, bucket: "dm" | "mention"): void {
  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(
    `insert into discord_items (
      item_id, message_id, bucket, status,
      action_taken, first_seen_at, last_seen_at
    ) values (?, ?, ?, 'pending', 'none', ?, ?)
    on conflict(item_id) do update set
      bucket = excluded.bucket,
      last_seen_at = excluded.last_seen_at`,
  ).run(messageId, messageId, bucket, now, now)
}

function isConfiguredDiscordChannel(channelId: string): boolean {
  return configuredChannelIdSet().has(channelId)
}

function detectInboxBucket(record: DiscordMessageRecord): "dm" | "mention" | null {
  if (record.isFromSelf) return null
  if (record.isDm) return "dm"
  if (record.mentionsBot && isConfiguredDiscordChannel(record.channelId)) return "mention"
  return null
}

export function ingestDiscordEvent(payload: unknown, options?: { botUserId?: string }): DiscordIngestResult {
  const record = parseMessageRecord(payload, options?.botUserId)
  if (!record) {
    return { stored: false, isNew: false, reason: "payload is missing message/channel identity" }
  }

  const db = getDb()
  const exists = db
    .prepare(`select 1 as present from discord_messages where message_id = ?`)
    .get(record.messageId) as { present?: number } | undefined
  const isNew = !exists

  const channelRecord = parseChannelRecord(payload, {
    channelId: record.channelId,
    guildId: record.guildId,
    channelType: record.channelType,
    isDm: record.isDm,
  })
  if (channelRecord) upsertDiscordChannel(channelRecord)

  upsertDiscordMessage(record)

  const bucket = detectInboxBucket(record)
  if (bucket) {
    upsertInboxItem(record.messageId, bucket)
    return {
      stored: true,
      isNew,
      messageId: record.messageId,
      itemId: record.messageId,
      bucket,
      isFromBot: record.isFromBot,
      isFromSelf: record.isFromSelf,
    }
  }

  return {
    stored: true,
    isNew,
    messageId: record.messageId,
    isFromBot: record.isFromBot,
    isFromSelf: record.isFromSelf,
    ...(!record.isDm && record.mentionsBot && !isConfiguredDiscordChannel(record.channelId)
      ? { reason: "ignored mention from unconfigured channel" }
      : {}),
  }
}

function ensureConfiguredChannelsMaterialized(channelIds?: string[] | string | null): void {
  const ids = parseChannelIds(channelIds)
  if (ids.length === 0) return

  const db = getDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `insert into discord_channels (
      channel_id, configured, first_seen_at, last_seen_at, raw_json
    ) values (?, 1, ?, ?, ?)
    on conflict(channel_id) do update set
      configured = 1,
      last_seen_at = excluded.last_seen_at`,
  )

  for (const channelId of ids) {
    stmt.run(channelId, now, now, "{}")
  }
}

function getDiscordMeta(key: string): string | null {
  const db = getDb()
  const row = db
    .prepare(`select value from discord_meta where key = ?`)
    .get(key) as { value?: string } | undefined
  return row?.value ?? null
}

function setDiscordMeta(key: string, value: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `insert into discord_meta (key, value, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, now)
}

function compactText(value: unknown, maxChars = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "(no text)"
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}...`
}

function formatBatchTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown-time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().replace("T", " ").replace(".000Z", "Z")
}

function extractReferencedMessageId(rawJson: string): string | null {
  try {
    const root = asObject(JSON.parse(rawJson))
    if (!root) return null
    const message = asObject(root.message) ?? root
    const reference =
      asObject(message.message_reference) ??
      asObject(root.message_reference) ??
      asObject(message.reference) ??
      asObject(root.reference)

    const direct =
      asString(reference?.message_id) ??
      asString(reference?.messageId) ??
      asString(reference?.id)
    if (direct) return direct

    const referencedMessage = asObject(message.referenced_message) ?? asObject(root.referenced_message)
    return asString(referencedMessage?.id)
  } catch {
    return null
  }
}

type DiscordReplyContext = {
  message_id: string
  author_id: string | null
  author_username: string | null
  content: string
}

function extractEmbeddedReferencedMessage(rawJson: string): DiscordReplyContext | null {
  try {
    const root = asObject(JSON.parse(rawJson))
    if (!root) return null
    const message = asObject(root.message) ?? root
    const referenced = asObject(message.referenced_message) ?? asObject(root.referenced_message)
    if (!referenced) return null

    const messageId = asString(referenced.id)
    if (!messageId) return null

    const author = asObject(referenced.author)
    return {
      message_id: messageId,
      author_id: asString(author?.id),
      author_username: asString(author?.username ?? author?.global_name),
      content: String(referenced.content ?? ""),
    }
  } catch {
    return null
  }
}

function buildReplyTargetContextMap(rows: Array<{ message_id: string; raw_json: string }>): Map<string, DiscordReplyContext> {
  const refsByMessage = new Map<string, { refId: string; embedded: DiscordReplyContext | null }>()
  for (const row of rows) {
    const refId = extractReferencedMessageId(row.raw_json)
    if (refId) refsByMessage.set(row.message_id, { refId, embedded: extractEmbeddedReferencedMessage(row.raw_json) })
  }

  if (refsByMessage.size === 0) return new Map()

  const refIds = Array.from(new Set([...refsByMessage.values()].map((ref) => ref.refId)))
  const db = getDb()
  const placeholders = refIds.map(() => "?").join(", ")
  const targetRows = db
    .prepare(
      `select message_id, author_id, author_username, content
       from discord_messages
       where message_id in (${placeholders})`,
    )
    .all(...refIds) as DiscordReplyContext[]

  const contextById = new Map<string, DiscordReplyContext>()
  for (const row of targetRows) {
    contextById.set(row.message_id, row)
  }

  const out = new Map<string, DiscordReplyContext>()
  for (const [messageId, ref] of refsByMessage.entries()) {
    const fallback = ref.embedded ?? {
      message_id: ref.refId,
      author_id: null,
      author_username: null,
      content: "",
    }
    out.set(messageId, contextById.get(ref.refId) ?? fallback)
  }

  return out
}

function formatReplyContext(reply: DiscordReplyContext | undefined): string {
  if (!reply) return ""
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return ` [reply_to ${author} msg/${reply.message_id}: ${JSON.stringify(reply.content)}]`
}

function autoDemoteStalePendingItems(staleMinutes: number): number {
  if (staleMinutes <= 0) return 0

  const db = getDb()
  const nowIso = new Date().toISOString()
  const cutoffIso = new Date(Date.now() - staleMinutes * 60_000).toISOString()
  const note = `auto-demoted after ${staleMinutes}m pending timeout`

  const result = db.prepare(
    `update discord_items
     set status = 'seen',
         action_taken = case when action_taken = 'none' then 'noted' else action_taken end,
         decision_note = coalesce(decision_note, ?),
         last_decision_at = ?,
         last_seen_at = ?
     where status = 'pending'
       and first_seen_at <= ?`,
  ).run(note, nowIso, nowIso, cutoffIso)

  return Number(result.changes ?? 0)
}

function repairDiscordMessageChannelFlags(): number {
  const db = getDb()
  const result = db.prepare(
    `update discord_messages
     set guild_id = (
           select c.guild_id from discord_channels c
           where c.channel_id = discord_messages.channel_id
             and c.guild_id is not null
         ),
         channel_type = coalesce(
           channel_type,
           (select c.channel_type from discord_channels c where c.channel_id = discord_messages.channel_id)
         ),
         is_dm = 0,
         last_seen_at = ?
     where is_dm = 1
       and exists (
         select 1 from discord_channels c
         where c.channel_id = discord_messages.channel_id
           and c.guild_id is not null
       )`,
  ).run(new Date().toISOString())

  return Number(result.changes ?? 0)
}

function channelLabel(row: {
  is_dm: number
  guild_name: string | null
  guild_id: string | null
  channel_name: string | null
  channel_id: string
}): string {
  if (row.is_dm === 1) return `dm/${row.channel_id}`
  const guild = row.guild_name ?? row.guild_id ?? "unknown-guild"
  const channel = row.channel_name ?? row.channel_id
  return `channel/${guild}/#${channel}`
}

function normalizeStatuses(input?: string[] | string | null): InboxStatus[] {
  const rawValues = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",").map((x) => x.trim())
      : ["pending"]

  const values = rawValues
    .map((x) => x.trim())
    .filter((x): x is InboxStatus => VALID_STATUS.has(x as InboxStatus))

  return values.length > 0 ? values : ["pending"]
}

export function listDiscordInbox(limit = 20, statuses?: string[] | string): unknown[] {
  const db = getDb()
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 20))
  const statusList = normalizeStatuses(statuses)
  const placeholders = statusList.map(() => "?").join(", ")

  const stmt = db.prepare(
    `select
      i.item_id,
      i.message_id,
      i.bucket,
      i.status,
      i.action_taken,
      i.decision_note,
      i.first_seen_at,
      i.last_seen_at,
      m.channel_id,
      m.guild_id,
      m.author_id,
      m.author_username,
      m.content,
      m.created_at,
      m.is_dm,
      m.mentions_bot
     from discord_items i
     join discord_messages m on m.message_id = i.message_id
     where i.status in (${placeholders})
     order by i.last_seen_at desc
     limit ?`,
  )

  return stmt.all(...statusList, safeLimit)
}

export function listDiscordBackread(channelId: string, limit = 40, beforeMessageId?: string): unknown[] {
  const db = getDb()
  const safeChannelId = String(channelId ?? "").trim()
  if (!safeChannelId) throw new Error("channel_id is required")

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 40))
  const before = String(beforeMessageId ?? "").trim()
  const rows = db
    .prepare(
      `select
        message_id,
        channel_id,
        guild_id,
        author_id,
        author_username,
        content,
        created_at,
        is_dm,
        mentions_bot,
        is_from_bot,
        raw_json
       from discord_messages
       where channel_id = ?
         and (? = '' or cast(message_id as integer) < cast(? as integer))
       order by cast(message_id as integer) desc
       limit ?`,
    )
    .all(safeChannelId, before, before, safeLimit) as Array<Record<string, unknown> & { message_id: string; raw_json: string }>

  const replyByMessageId = buildReplyTargetContextMap(rows)
  return rows.map(({ raw_json: _rawJson, ...row }) => ({
    ...row,
    ...(replyByMessageId.has(row.message_id) ? { reply_to: replyByMessageId.get(row.message_id) } : {}),
  }))
}

export function markDiscordItem(itemId: string, status: InboxStatus, note = "", action: InboxAction = "none"): void {
  const safeItemId = String(itemId ?? "").trim()
  if (!safeItemId) throw new Error("item_id is required")
  if (!VALID_STATUS.has(status)) throw new Error(`invalid status: ${status}`)
  if (!VALID_ACTION.has(action)) throw new Error(`invalid action: ${action}`)

  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(
    `update discord_items
     set status = ?, action_taken = ?, decision_note = ?, last_decision_at = ?, last_seen_at = ?
     where item_id = ?`,
  ).run(status, action, note || null, now, now, safeItemId)
}

export function listDiscordChannels(): unknown[] {
  ensureConfiguredChannelsMaterialized()
  const db = getDb()

  return db
    .prepare(
      `select
        channel_id,
        configured,
        guild_id,
        guild_name,
        channel_name,
        channel_type,
        is_dm,
        topic,
        note,
        last_note_at,
        last_seen_at
       from discord_channels
       where configured = 1
          or note is not null
          or (
            is_dm = 1
            and exists (
              select 1 from discord_messages m
              where m.channel_id = discord_channels.channel_id
            )
          )
       order by configured desc, coalesce(guild_name, ''), coalesce(channel_name, channel_id)`,
    )
    .all()
}

export function setDiscordChannelNote(channelId: string, note: string): Record<string, unknown> {
  const safeChannelId = String(channelId ?? "").trim()
  if (!safeChannelId) throw new Error("channel_id is required")

  ensureConfiguredChannelsMaterialized([safeChannelId])

  const db = getDb()
  const now = new Date().toISOString()
  const trimmed = note.trim()

  db.prepare(
    `update discord_channels
     set note = ?, last_note_at = ?, last_seen_at = ?
     where channel_id = ?`,
  ).run(trimmed.length > 0 ? trimmed : null, now, now, safeChannelId)

  const row = db
    .prepare(
      `select channel_id, configured, guild_id, guild_name, channel_name, note, last_note_at
       from discord_channels
       where channel_id = ?`,
    )
    .get(safeChannelId) as Record<string, unknown> | undefined

  return {
    ok: true,
    cleared: trimmed.length === 0,
    ...(row ?? { channel_id: safeChannelId }),
  }
}

export function buildDiscordBatchDigest(params?: {
  maxMessages?: number
  pendingPreviewLimit?: number
  intervalMs?: number
}): DiscordBatchDigest | null {
  const db = getDb()
  const now = new Date()
  const nowIso = now.toISOString()
  const defaultIntervalMs = Math.max(
    1_000,
    Number.parseInt(process.env.DISCORD_BATCH_INTERVAL_MS ?? "60000", 10) || 60_000,
  )
  const intervalMs = Math.max(1_000, Math.trunc(params?.intervalMs ?? defaultIntervalMs))
  const maxMessages = Math.max(1, Math.min(200, Math.trunc(params?.maxMessages ?? 40) || 40))
  const previewLimit = Math.max(1, Math.min(50, Math.trunc(params?.pendingPreviewLimit ?? 6) || 6))
  const batchOnlyConfigured = (process.env.DISCORD_BATCH_ONLY_CONFIGURED ?? "true").trim().toLowerCase() !== "false"
  const autoSeenMinutes = Math.max(
    0,
    Number.parseInt(process.env.DISCORD_PENDING_AUTO_SEEN_MINUTES ?? "10", 10) || 10,
  )
  const channelScopeClause = batchOnlyConfigured
    ? "and (m.is_dm = 1 or coalesce(c.configured, 0) = 1)"
    : ""
  const botUserId = process.env.DISCORD_BOT_USER_ID?.trim() ?? ""

  const autoDemotedCount = autoDemoteStalePendingItems(autoSeenMinutes)
  const repairedMessageCount = repairDiscordMessageChannelFlags()

  const from =
    getDiscordMeta("discord_batch_last_dispatched_at") ??
    new Date(now.getTime() - intervalMs).toISOString()

  const messageRows = db
    .prepare(
      `select
         m.message_id,
         m.channel_id,
         m.guild_id,
         m.author_username,
         m.content,
         m.created_at,
         m.first_seen_at,
         m.is_dm,
         m.raw_json,
         c.guild_name,
         c.channel_name
       from discord_messages m
       left join discord_channels c on c.channel_id = m.channel_id
       left join discord_items i on i.message_id = m.message_id
       where (? = '' or coalesce(m.author_id, '') != ?)
         and m.first_seen_at > ?
         and (i.message_id is null or i.status = 'pending')
         ${channelScopeClause}
       order by m.first_seen_at asc
       limit ?`,
    )
    .all(botUserId, botUserId, from, maxMessages + 1) as Array<{
      message_id: string
      channel_id: string
      guild_id: string | null
      author_username: string | null
      content: string
      created_at: string
      first_seen_at: string
      is_dm: number
      raw_json: string
      guild_name: string | null
      channel_name: string | null
    }>

  if (messageRows.length === 0) return null

  const truncated = messageRows.length > maxMessages
  const recentMessages = truncated ? messageRows.slice(0, maxMessages) : messageRows

  const pendingCountRow = db
    .prepare(
      `select count(*) as count
       from discord_items i
       join discord_messages m on m.message_id = i.message_id
       left join discord_channels c on c.channel_id = m.channel_id
       where i.status = 'pending'
       and (? = '' or coalesce(m.author_id, '') != ?)
       ${channelScopeClause}`,
    )
    .get(botUserId, botUserId) as { count?: number } | undefined
  const pendingCount = pendingCountRow?.count ?? 0

  const pendingPreview = db
    .prepare(
      `select
         i.item_id,
         i.bucket,
         m.channel_id,
         m.guild_id,
         m.author_username,
         m.content,
         m.created_at,
         m.is_dm,
         m.message_id,
         m.raw_json,
         c.guild_name,
         c.channel_name
       from discord_items i
       join discord_messages m on m.message_id = i.message_id
       left join discord_channels c on c.channel_id = m.channel_id
       where i.status = 'pending'
         and (? = '' or coalesce(m.author_id, '') != ?)
         ${channelScopeClause}
       order by i.last_seen_at desc
       limit ?`,
    )
    .all(botUserId, botUserId, previewLimit) as Array<{
      item_id: string
      bucket: string
      channel_id: string
      guild_id: string | null
      author_username: string | null
      content: string
      created_at: string
      is_dm: number
      message_id: string
      raw_json: string
      guild_name: string | null
      channel_name: string | null
    }>

  const uniqueChannels = new Set(recentMessages.map((row) => row.channel_id))
  const replyContextByMessageId = buildReplyTargetContextMap([...recentMessages, ...pendingPreview])

  const lines: string[] = [
    `[discord batch] ${from} -> ${nowIso}`,
    `new_messages=${recentMessages.length}${truncated ? "+" : ""} channels=${uniqueChannels.size} pending_inbox=${pendingCount} scope=${batchOnlyConfigured ? "configured+dm" : "all"}`,
    `auto_seen_timeout=${autoSeenMinutes}m auto_demoted=${autoDemotedCount}`,
    `channel_flag_repairs=${repairedMessageCount}`,
    "channel messages are context, not direct requests. replying is optional; use judgment.",
    "",
    "recent messages:",
  ]

  for (const row of recentMessages) {
    const label = channelLabel(row)
    const author = row.author_username ? `@${row.author_username}` : "@unknown"
    const ts = formatBatchTimestamp(row.created_at)
    const replyTo = replyContextByMessageId.get(row.message_id)
    lines.push(`- [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}: ${compactText(row.content)}`)
  }

  if (truncated) {
    lines.push(`- ...truncated at ${maxMessages} messages`)
  }

  lines.push("")
  lines.push("pending preview:")
  if (pendingPreview.length === 0) {
    lines.push("- (none)")
  } else {
    for (const row of pendingPreview) {
      const label = channelLabel(row)
      const author = row.author_username ? `@${row.author_username}` : "@unknown"
      const ts = formatBatchTimestamp(row.created_at)
      const replyTo = replyContextByMessageId.get(row.message_id)
      lines.push(`- ${row.item_id} [${row.bucket}] [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}: ${compactText(row.content, 120)}`)
    }
  }

  lines.push("")
  lines.push("you can reply if useful via discord_send, or choose not to reply. mark decisions with discord_mark when you handle pending items.")

  setDiscordMeta("discord_batch_last_dispatched_at", nowIso)

  return {
    content: lines.join("\n"),
    messageCount: recentMessages.length,
    pendingCount,
    from,
    to: nowIso,
  }
}

function resolveReferenceMessage(channelId: string, sourceItemId?: string, referenceMessage?: string): string | null {
  const ref = referenceMessage?.trim()
  if (ref) {
    const db = getDb()

    // If it looks like a snowflake ID, verify it exists in cache
    if (/^\d+$/.test(ref)) {
      const exists = db
        .prepare(`select 1 from discord_messages where message_id = ?`)
        .get(ref)
      return exists ? ref : null
    }

    // Try matching by message content (most recent in channel)
    const byContent = db
      .prepare(
        `select message_id from discord_messages
         where channel_id = ? and content like ? and is_from_bot = 0
         order by cast(message_id as integer) desc limit 1`,
      )
      .get(channelId, `%${ref}%`) as { message_id?: string } | undefined
    if (byContent?.message_id) return byContent.message_id

    // Try matching by author username (most recent message in channel)
    const byUsername = db
      .prepare(
        `select message_id from discord_messages
         where channel_id = ? and author_username like ? and is_from_bot = 0
         order by cast(message_id as integer) desc limit 1`,
      )
      .get(channelId, `%${ref}%`) as { message_id?: string } | undefined
    if (byUsername?.message_id) return byUsername.message_id

    return null
  }

  if (!sourceItemId?.trim()) return null

  const db = getDb()
  const row = db
    .prepare(`select message_id from discord_items where item_id = ?`)
    .get(sourceItemId.trim()) as { message_id?: string } | undefined

  return row?.message_id?.trim() ? row.message_id : null
}

function shouldUseExplicitReference(channelId: string, sourceMessageId: string): boolean {
  const db = getDb()
  const source = db
    .prepare(
      `select message_id, channel_id, author_id, created_at
       from discord_messages
       where message_id = ?`,
    )
    .get(sourceMessageId) as { message_id?: string; channel_id?: string; author_id?: string | null; created_at?: string } | undefined

  if (!source?.message_id || !source.channel_id) return false
  if (source.channel_id !== channelId) return false

  const createdMs = Date.parse(source.created_at ?? "")
  if (Number.isFinite(createdMs)) {
    const staleMs = AUTO_REPLY_STALE_MINUTES * 60_000
    if (Date.now() - createdMs >= staleMs) return true
  }

  const row = db
    .prepare(
      `select count(*) as count
       from discord_messages
       where channel_id = ?
         and cast(message_id as integer) > cast(? as integer)
         and is_from_bot = 0
         and coalesce(author_id, '') != coalesce(?, '')`,
    )
    .get(channelId, sourceMessageId, source.author_id ?? "") as { count?: number } | undefined

  return (row?.count ?? 0) > 0
}

async function chooseMessageReference(options: {
  channelId: string
  replyMode: ReplyMode
  sourceItemId?: string
  referenceMessage?: string
}): Promise<string | null> {
  const sourceMessageId = resolveReferenceMessage(options.channelId, options.sourceItemId, options.referenceMessage)
  if (!sourceMessageId) return null

  if (options.replyMode === "plain") return null
  if (options.replyMode === "explicit") return sourceMessageId

  return shouldUseExplicitReference(options.channelId, sourceMessageId) ? sourceMessageId : null
}

function inferPendingDmItemId(channelId: string): string | null {
  const db = getDb()
  const row = db
    .prepare(
      `select i.item_id
       from discord_items i
       join discord_messages m on m.message_id = i.message_id
       where i.status = 'pending'
         and m.channel_id = ?
         and m.is_dm = 1
         and m.is_from_bot = 0
       order by cast(m.message_id as integer) desc
       limit 1`,
    )
    .get(channelId) as { item_id?: string } | undefined

  return row?.item_id?.trim() ? row.item_id : null
}

function normalizeReplyMode(value: unknown): ReplyMode {
  if (value === "plain" || value === "explicit" || value === "auto") return value
  return "auto"
}

export async function scanDiscordChannels(params?: {
  limit?: number
  channelIds?: string[] | string
  beforeMessageId?: string
}): Promise<Record<string, unknown>> {
  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const channelIds = parseChannelIds(params?.channelIds)
  ensureConfiguredChannelsMaterialized(channelIds)
  if (channelIds.length === 0) {
    return {
      scanned_channels: 0,
      fetched_messages: 0,
      stored_messages: 0,
      inbox_items: 0,
      note: "no channels configured; set DISCORD_SCAN_CHANNEL_IDS or pass channel_ids",
    }
  }

  const limit = Math.max(1, Math.min(100, Math.trunc(params?.limit ?? DEFAULT_SCAN_LIMIT) || DEFAULT_SCAN_LIMIT))
  const before = asString(params?.beforeMessageId)

  let fetchedMessages = 0
  let storedMessages = 0
  let inboxItems = 0
  const guildNameCache = new Map<string, string | null>()

  for (const channelId of channelIds) {
    const channel = (await withDiscordRestRetry(`get channel ${channelId}`, () =>
      rest.get(Routes.channel(channelId)),
    )) as DiscordObject
    const channelType = asNumber(channel.type)
    const guildId = asString(channel.guild_id)
    let guildName: string | null = null
    if (guildId) {
      if (guildNameCache.has(guildId)) {
        guildName = guildNameCache.get(guildId) ?? null
      } else {
        try {
          const guild = (await withDiscordRestRetry(`get guild ${guildId}`, () =>
            rest.get(Routes.guild(guildId)),
          )) as DiscordObject
          guildName = asString(guild.name)
          guildNameCache.set(guildId, guildName)
        } catch (err) {
          console.warn(`[discord scan] failed to resolve guild ${guildId}: ${errorMessage(err)}`)
          guildNameCache.set(guildId, null)
        }
      }
    }

    upsertDiscordChannel({
      channelId,
      guildId,
      channelType,
      channelName: asString(channel.name),
      guildName,
      topic: asString(channel.topic),
      isDm: channelType === 1 || channelType === 3,
      configured: true,
      rawJson: JSON.stringify(channel),
    })
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set("before", before)

    const messages = (await withDiscordRestRetry(`get channel messages ${channelId}`, () =>
      rest.get(Routes.channelMessages(channelId), {
        query,
      }),
    )) as unknown[]

    fetchedMessages += messages.length

    for (const message of messages) {
      const result = ingestDiscordEvent(
        {
          message,
          channel: {
            id: channelId,
            type: channelType,
            guild_id: guildId,
          },
        },
        { botUserId },
      )

      if (result.stored) {
        storedMessages += 1
        if (result.itemId) inboxItems += 1
      }
    }
  }

  return {
    scanned_channels: channelIds.length,
    fetched_messages: fetchedMessages,
    stored_messages: storedMessages,
    inbox_items: inboxItems,
  }
}

export async function sendDiscordMessage(params: {
  channelId?: string
  content: string
  sourceItemId?: string
  replyMode?: string
  referenceMessage?: string
}): Promise<Record<string, unknown>> {
  let channelId = String(params.channelId ?? "").trim()
  if (!channelId && params.sourceItemId?.trim()) {
    const db = getDb()
    const row = db
      .prepare(
        `select m.channel_id
         from discord_items i
         join discord_messages m on m.message_id = i.message_id
         where i.item_id = ?`,
      )
      .get(params.sourceItemId.trim()) as { channel_id?: string } | undefined
    channelId = row?.channel_id?.trim() ?? ""
  }
  if (!channelId) throw new Error("channel_id is required (or provide source_item_id that maps to one)")

  const content = String(params.content ?? "").trim()
  if (!content) throw new Error("content is required")

  const replyMode = normalizeReplyMode(params.replyMode)
  const explicitSourceItemId = params.sourceItemId?.trim() ? params.sourceItemId.trim() : null
  const inferredSourceItemId = explicitSourceItemId ? null : inferPendingDmItemId(channelId)
  const resolvedSourceItemId = explicitSourceItemId ?? inferredSourceItemId
  const referenceMessageId = await chooseMessageReference({
    channelId,
    replyMode,
    sourceItemId: resolvedSourceItemId ?? undefined,
    referenceMessage: params.referenceMessage,
  })

  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const message = (await withDiscordRestRetry(`send message ${channelId}`, () =>
    rest.post(Routes.channelMessages(channelId), {
      body: {
        content,
        ...(referenceMessageId
          ? {
              message_reference: {
                message_id: referenceMessageId,
                channel_id: channelId,
                fail_if_not_exists: false,
              },
              allowed_mentions: { replied_user: false },
            }
          : {}),
      },
    }),
  )) as DiscordObject

  const ingest = ingestDiscordEvent(
    {
      message,
      channel: {
        id: channelId,
        type: message.type,
        guild_id: message.guild_id,
      },
      author_is_bot: true,
    },
    { botUserId },
  )

  if (resolvedSourceItemId) {
    const wasInferred = !explicitSourceItemId
    markDiscordItem(
      resolvedSourceItemId,
      "acted",
      `responded via discord_send (${replyMode}${referenceMessageId ? ", explicit" : ", plain"}${wasInferred ? ", inferred_dm_item" : ""})`,
      referenceMessageId ? "replied" : "messaged",
    )
  }

  return {
    ok: true,
    sent_message_id: asString(message.id),
    channel_id: channelId,
    reply_mode: replyMode,
    used_reference_message_id: referenceMessageId,
    resolved_source_item_id: resolvedSourceItemId,
    inferred_source_item_id: inferredSourceItemId,
    stored: ingest.stored,
  }
}
