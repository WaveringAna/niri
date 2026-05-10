/**
 * Discord inbox orchestration — ingest, batch digest, scanning, sending, and listing.
 *
 * Public API remains identical; internal parsing, REST, and DB operations
 * are delegated to their respective modules.
 *
 * @module discord/state
 */

import { Routes } from "discord.js"
import { getDb } from "../db"
import {
  asNumber,
  asObject,
  asString,
  configuredChannelIdSet,
  parseChannelIds,
  parseChannelRecord,
  parseMessageRecord,
  type DiscordObject,
} from "./parse"
import {
  autoDemoteStalePendingItems,
  buildReplyTargetContextMap,
  ensureConfiguredChannelsMaterialized,
  getDiscordMeta,
  isConfiguredDiscordChannel,
  normalizeStatuses,
  setDiscordMeta,
  upsertDiscordChannel,
  upsertInboxItem,
  upsertDiscordMessage,
  repairDiscordMessageChannelFlags,
  type DiscordReplyContext,
} from "./db"
import {
  errorMessage,
  getBotUserId,
  makeRestClient,
  withDiscordRestRetry,
} from "./rest"

// ── result types ───────────────────────────────────────────────────────

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

// ── formatting helpers ─────────────────────────────────────────────────

function compactText(value: unknown, maxChars = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "(no text)"
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}...`
}

function fullMessageText(value: unknown): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim()
  if (!text) return "(no text)"
  return text.replace(/\n/g, "\n  ")
}

function formatHumanTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function formatBatchTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown-time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().replace("T", " ").replace(".000Z", "Z")
}

function formatReplyContext(reply: DiscordReplyContext | undefined): string {
  if (!reply) return ""
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return ` [reply_to ${author} msg/${reply.message_id}: ${JSON.stringify(reply.content)}]`
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

// ── inbox detection ────────────────────────────────────────────────────

function detectInboxBucket(record: ReturnType<typeof parseMessageRecord>): "dm" | "mention" | null {
  if (!record) return null
  if (record.isFromSelf) return null
  if (record.isDm) return "dm"
  if (record.mentionsBot && isConfiguredDiscordChannel(record.channelId)) return "mention"
  return null
}

// ── ingest ─────────────────────────────────────────────────────────────

/**
 * Parses and persists a Discord event into the local message/channel/inbox tables.
 *
 * @param payload - Raw Discord gateway or webhook payload.
 * @param options - Optional bot user id override.
 * @returns Ingest result describing what was stored and classified.
 */
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

// ── inbox listing ──────────────────────────────────────────────────────

/**
 * Lists Discord inbox items from local state.
 *
 * @param limit - Maximum rows (default 20, max 200).
 * @param statuses - Status filter string or array.
 * @returns Raw inbox rows.
 */
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

// ── backread ───────────────────────────────────────────────────────────

/**
 * Reads stored Discord message history for a channel, newest first.
 *
 * @param channelId - Discord channel id.
 * @param limit - Maximum rows (default 40, max 200).
 * @param beforeMessageId - Optional cursor for pagination.
 * @returns Message rows with resolved reply context.
 */
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
    created_at: formatHumanTimestamp(row.created_at as string | undefined),
    ...(replyByMessageId.has(row.message_id) ? { reply_to: replyByMessageId.get(row.message_id) } : {}),
  }))
}

// ── mark ───────────────────────────────────────────────────────────────

type InboxStatus = "pending" | "seen" | "acted" | "ignored"
type InboxAction = "none" | "replied" | "messaged" | "dismissed" | "noted"

const VALID_ACTION = new Set<InboxAction>(["none", "replied", "messaged", "dismissed", "noted"])

/**
 * Updates decision state for a Discord inbox item.
 *
 * @param itemId - Inbox item id.
 * @param status - New status.
 * @param note - Optional decision note.
 * @param action - Action taken.
 */
export function markDiscordItem(itemId: string, status: InboxStatus, note = "", action: InboxAction = "none"): void {
  const safeItemId = String(itemId ?? "").trim()
  if (!safeItemId) throw new Error("item_id is required")
  if (!["pending", "seen", "acted", "ignored"].includes(status)) throw new Error(`invalid status: ${status}`)
  if (!VALID_ACTION.has(action)) throw new Error(`invalid action: ${action}`)

  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(
    `update discord_items
     set status = ?, action_taken = ?, decision_note = ?, last_decision_at = ?, last_seen_at = ?
     where item_id = ?`,
  ).run(status, action, note || null, now, now, safeItemId)
}

// ── channels listing / notes ───────────────────────────────────────────

/**
 * Lists configured Discord channels and DM channels with stored interactions.
 *
 * @returns Channel rows.
 */
export function listDiscordChannels(): unknown[] {
  ensureConfiguredChannelsMaterialized()
  const db = getDb()
  const configuredIds = parseChannelIds()
  const configuredPlaceholders = configuredIds.map(() => "?").join(", ")
  const configuredClause = configuredIds.length > 0 ? `channel_id in (${configuredPlaceholders})` : "0"

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
       where ${configuredClause}
          or (
            is_dm = 1
            and exists (
              select 1 from discord_messages m
              where m.channel_id = discord_channels.channel_id
            )
          )
       order by configured desc, coalesce(guild_name, ''), coalesce(channel_name, channel_id)`,
    )
    .all(...configuredIds)
}

/**
 * Sets or clears a persistent note for a Discord channel.
 *
 * @param channelId - Channel id to annotate.
 * @param note - Note text (empty string clears it).
 * @returns Updated channel row.
 */
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

// ── batch digest ───────────────────────────────────────────────────────

const DEFAULT_SCAN_LIMIT = 50

/**
 * Builds a formatted batch digest of recent Discord activity for the runner.
 *
 * @param params - Optional batch parameters.
 * @returns Formatted digest, or `null` when no new messages exist.
 */
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
  const configuredIds = parseChannelIds()
  const configuredPlaceholders = configuredIds.map(() => "?").join(", ")
  const channelScopeClause = batchOnlyConfigured
    ? configuredIds.length > 0
      ? `and (m.is_dm = 1 or m.channel_id in (${configuredPlaceholders}))`
      : "and m.is_dm = 1"
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
    .all(botUserId, botUserId, from, ...configuredIds, maxMessages + 1) as Array<{
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
    .get(botUserId, botUserId, ...configuredIds) as { count?: number } | undefined
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
    .all(botUserId, botUserId, ...configuredIds, previewLimit) as Array<{
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
    lines.push(`- [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}: ${fullMessageText(row.content)}`)
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

// ── send ───────────────────────────────────────────────────────────────

type ReplyMode = "auto" | "plain" | "explicit"

function resolveReferenceMessage(channelId: string, sourceItemId?: string, referenceMessage?: string): string | null {
  const ref = referenceMessage?.trim()
  if (ref) {
    const db = getDb()

    if (/^\d+$/.test(ref)) {
      const exists = db
        .prepare(`select 1 from discord_messages where message_id = ?`)
        .get(ref)
      return exists ? ref : null
    }

    const byContent = db
      .prepare(
        `select message_id from discord_messages
         where channel_id = ? and content like ? and is_from_bot = 0
         order by cast(message_id as integer) desc limit 1`,
      )
      .get(channelId, `%${ref}%`) as { message_id?: string } | undefined
    if (byContent?.message_id) return byContent.message_id

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

const AUTO_REPLY_STALE_MINUTES = 10

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

/**
 * Sends a Discord message with optional reply reference resolution.
 *
 * @param params - Send parameters including channel, content, and reply options.
 * @returns Send result with message id and resolved reference information.
 */
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
        type: message.guild_id == null ? 1 : null,
        guild_id: message.guild_id,
      },
      is_dm: message.guild_id == null,
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

// ── scan ───────────────────────────────────────────────────────────────

/**
 * Scans configured Discord channels via REST API and ingests messages.
 *
 * @param params - Scan parameters.
 * @returns Summary of scanned channels and fetched/stored messages.
 */
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
