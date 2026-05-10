/**
 * Discord SQLite persistence layer — upserts, meta, and maintenance queries.
 *
 * @module discord/db
 */

import { getDb } from "../db"
import {
  asBoolean,
  asNumber,
  asString,
  configuredChannelIdSet,
  parseChannelIds,
  type DiscordChannelRecord,
  type DiscordMessageRecord,
} from "./parse"

// ── channel / message upserts ──────────────────────────────────────────

/**
 * Persists a parsed Discord channel record, creating or updating as needed.
 *
 * @param record - Channel data to upsert.
 */
export function upsertDiscordChannel(record: DiscordChannelRecord): void {
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

/**
 * Persists a parsed Discord message record, creating or updating as needed.
 *
 * @param record - Message data to upsert.
 */
export function upsertDiscordMessage(record: DiscordMessageRecord): void {
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

/**
 * Creates or updates an inbox item for a given message.
 *
 * @param messageId - Discord message id (also used as item id).
 * @param bucket - Inbox bucket (`"dm"` or `"mention"`).
 */
export function upsertInboxItem(messageId: string, bucket: "dm" | "mention"): void {
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

// ── meta key/value ─────────────────────────────────────────────────────

/**
 * Reads a value from the `discord_meta` table.
 *
 * @param key - Meta key.
 * @returns Stored value or `null`.
 */
export function getDiscordMeta(key: string): string | null {
  const db = getDb()
  const row = db
    .prepare(`select value from discord_meta where key = ?`)
    .get(key) as { value?: string } | undefined
  return row?.value ?? null
}

/**
 * Writes a value to the `discord_meta` table.
 *
 * @param key - Meta key.
 * @param value - Value to store.
 */
export function setDiscordMeta(key: string, value: string): void {
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

// ── channel configuration ──────────────────────────────────────────────

/**
 * Ensures configured channel ids exist in the `discord_channels` table.
 *
 * @param channelIds - Optional override channel ids.
 */
export function ensureConfiguredChannelsMaterialized(channelIds?: string[] | string | null): void {
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

// ── maintenance ────────────────────────────────────────────────────────

/**
 * Auto-demotes stale pending inbox items to `"seen"` after a timeout.
 *
 * @param staleMinutes - Minutes after which pending items are demoted.
 * @returns Number of demoted items.
 */
export function autoDemoteStalePendingItems(staleMinutes: number): number {
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

/**
 * Repairs DM/guild flags on messages and channels based on cross-referenced data.
 *
 * @returns Total number of repaired rows.
 */
export function repairDiscordMessageChannelFlags(): number {
  const db = getDb()
  const now = new Date().toISOString()

  const dmMessageResult = db.prepare(
    `update discord_messages
     set is_dm = 1,
         channel_type = coalesce(channel_type, 1),
         last_seen_at = ?
     where guild_id is null
       and is_dm = 0`,
  ).run(now)

  const dmChannelResult = db.prepare(
    `update discord_channels
     set is_dm = 1,
         channel_type = case
           when channel_type is null or channel_type = 0 then 1
           else channel_type
         end,
         last_seen_at = ?
     where is_dm = 0
       and exists (
         select 1 from discord_messages m
         where m.channel_id = discord_channels.channel_id
           and m.guild_id is null
           and m.is_dm = 1
       )`,
  ).run(now)

  const guildMessageResult = db.prepare(
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
  ).run(now)

  return Number(dmMessageResult.changes ?? 0) + Number(dmChannelResult.changes ?? 0) + Number(guildMessageResult.changes ?? 0)
}

// ── inbox queries ──────────────────────────────────────────────────────

type InboxStatus = "pending" | "seen" | "acted" | "ignored"

const VALID_STATUS = new Set<InboxStatus>(["pending", "seen", "acted", "ignored"])

/**
 * Normalizes a status filter input into a validated array of inbox statuses.
 *
 * @param input - Comma-separated string or array.
 * @returns Array of valid statuses, defaulting to `["pending"]`.
 */
export function normalizeStatuses(input?: string[] | string | null): InboxStatus[] {
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

/**
 * Returns whether a channel id is in the configured set.
 *
 * @param channelId - Channel id to check.
 * @returns `true` when the channel is configured for inbox scanning.
 */
export function isConfiguredDiscordChannel(channelId: string): boolean {
  return configuredChannelIdSet().has(channelId)
}

// ── reply context ──────────────────────────────────────────────────────

export type DiscordReplyContext = {
  message_id: string
  author_id: string | null
  author_username: string | null
  content: string
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Extracts the referenced (replied-to) message id from raw JSON.
 *
 * @param rawJson - Stored raw JSON for a Discord message.
 * @returns Referenced message id, or `null`.
 */
export function extractReferencedMessageId(rawJson: string): string | null {
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

/**
 * Extracts an embedded referenced message from raw JSON (for messages that include it inline).
 *
 * @param rawJson - Stored raw JSON for a Discord message.
 * @returns Parsed reply context, or `null`.
 */
export function extractEmbeddedReferencedMessage(rawJson: string): DiscordReplyContext | null {
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

/**
 * Builds a map of message id → reply context for a set of messages that may reference others.
 *
 * @param rows - Messages with raw_json to scan for references.
 * @returns Map from message id to the reply target context.
 */
export function buildReplyTargetContextMap(rows: Array<{ message_id: string; raw_json: string }>): Map<string, DiscordReplyContext> {
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
