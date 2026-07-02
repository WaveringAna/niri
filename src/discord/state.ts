/**
 * Discord inbox orchestration — ingest, batch digest, scanning, sending, and listing.
 *
 * All SQL lives in `./db`; this module owns formatting, REST calls,
 * and the high-level workflows that compose db + rest + parse primitives.
 *
 * @module discord/state
 */

import { Routes } from "discord.js"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  asNumber,
  asString,
  extractImageAttachmentsFromRawJson,
  parseChannelIds,
  parseChannelRecord,
  parseMessageRecord,
  type DiscordObject,
} from "./parse"
import { inactiveCooldownChannelIds } from "./cooldown"
import {
  autoDemoteStalePendingItems,
  buildReplyTargetContextMap,
  countInterveningMessages,
  countPendingInbox,
  ensureConfiguredChannelsMaterialized,
  findMessageByContent,
  findMessageByUsername,
  findPendingDmItemId,
  getChannelRow,
  getDiscordMeta,
  getItemChannelId,
  getItemMessageId,
  getMessageForReference,
  isConfiguredDiscordChannel,
  messageExists,
  messageExistsById,
  normalizeStatuses,
  queryBatchMessages,
  queryBatchPendingPreview,
  queryChannels,
  queryChannelMessages,
  queryInboxItems,
  repairDiscordMessageChannelFlags,
  setDiscordMeta,
  updateChannelNote,
  updateInboxItem,
  upsertDiscordChannel,
  upsertInboxItem,
  upsertDiscordMessage,
  type BackreadRow,
  type BatchMessageRow,
  type BatchPendingRow,
  type DiscordReplyContext,
  type InboxAction,
  type InboxStatus,
  VALID_ACTION,
} from "./db"
import {
  errorMessage,
  getBotUserId,
  makeRestClient,
  withDiscordRestRetry,
} from "./rest"
import { maybeFetchAndCachePronouns } from "./pronouns"

// ── result types ───────────────────────────────────────────────────────

export type DiscordIngestResult = {
  stored: boolean
  isNew: boolean
  messageId?: string
  channelId?: string
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
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function formatBatchImages(rawJson: string): string {
  const images = extractImageAttachmentsFromRawJson(rawJson)
  if (images.length === 0) return ""
  return ` [images: ${images.map((img) => img.url).join(" ")}]`
}

function formatReplyContext(reply: DiscordReplyContext | undefined): string {
  if (!reply) return ""
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return ` [reply_to ${author} msg/${reply.message_id}: ${JSON.stringify(reply.content)}]`
}

function channelLabel(row: { is_dm: number; guild_name: string | null; guild_id: string | null; channel_name: string | null; channel_id: string }): string {
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

  if (record.isDm && !record.isFromSelf) {
    const whitelist = process.env.DISCORD_DM_WHITELIST
    if (whitelist && whitelist.trim()) {
      const allowedIds = whitelist.split(",").map((id) => id.trim()).filter(Boolean)
      if (!record.authorId || !allowedIds.includes(record.authorId)) {
        return {
          stored: false,
          isNew: false,
          reason: "ignored DM: sender is not in DISCORD_DM_WHITELIST",
        }
      }
    }
  }

  const isNew = !messageExists(record.messageId)

  const channelRecord = parseChannelRecord(payload, {
    channelId: record.channelId,
    guildId: record.guildId,
    channelType: record.channelType,
    isDm: record.isDm,
  })
  if (channelRecord) upsertDiscordChannel(channelRecord)

  upsertDiscordMessage(record)

  if (record.authorId) {
    void maybeFetchAndCachePronouns(record.authorId)
  }

  const bucket = detectInboxBucket(record)
  if (bucket) {
    upsertInboxItem(record.messageId, bucket)
    return {
      stored: true,
      isNew,
      messageId: record.messageId,
      channelId: record.channelId,
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
    channelId: record.channelId,
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
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 20))
  const statusList = normalizeStatuses(statuses)
  return queryInboxItems(statusList, safeLimit)
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
  const safeChannelId = String(channelId ?? "").trim()
  if (!safeChannelId) throw new Error("channel_id is required")

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 40))
  const before = String(beforeMessageId ?? "").trim()
  const rows = queryChannelMessages(safeChannelId, before, safeLimit)

  const replyByMessageId = buildReplyTargetContextMap(rows)
  return rows.map(({ raw_json: _rawJson, ...row }) => ({
    ...row,
    source_item_id: row.message_id,
    created_at: formatHumanTimestamp(row.created_at),
    ...(replyByMessageId.has(row.message_id) ? { reply_to: replyByMessageId.get(row.message_id) } : {}),
  }))
}

// ── mark ───────────────────────────────────────────────────────────────

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
  updateInboxItem(safeItemId, status, action, note || null)
}

// ── channels listing / notes ───────────────────────────────────────────

/**
 * Lists configured Discord channels and DM channels with stored interactions.
 *
 * @returns Channel rows.
 */
export function listDiscordChannels(): unknown[] {
  ensureConfiguredChannelsMaterialized()
  const configuredIds = parseChannelIds()
  return queryChannels(configuredIds)
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
  const trimmed = note.trim()
  updateChannelNote(safeChannelId, trimmed.length > 0 ? trimmed : null)

  const row = getChannelRow(safeChannelId)
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

  // Cooldown channels outside their active window: spare their pending items
  // from both the stale-demote and this digest, so they resurface when active.
  const inactiveChannelIds = inactiveCooldownChannelIds()

  autoDemoteStalePendingItems(autoSeenMinutes, inactiveChannelIds)
  repairDiscordMessageChannelFlags()

  const from =
    getDiscordMeta("discord_batch_last_dispatched_at") ??
    new Date(now.getTime() - intervalMs).toISOString()

  const queryOpts = { botUserId, from, configuredIds, channelScopeClause }

  const messageRows = queryBatchMessages({ ...queryOpts, limit: maxMessages + 1 })

  if (messageRows.length === 0) return null

  const truncated = messageRows.length > maxMessages
  const recentMessages = truncated ? messageRows.slice(0, maxMessages) : messageRows

  const pendingCount = countPendingInbox(queryOpts)

  const pendingPreview = queryBatchPendingPreview({ ...queryOpts, limit: previewLimit })

  // Cooldown channels outside their active window are dropped from this digest
  // and left as `pending` so they resurface once the window opens. The inactive
  // set was computed above (before the stale-demote) and reused here.
  const visibleRecentMessages = inactiveChannelIds.length
    ? recentMessages.filter((row) => !inactiveChannelIds.includes(row.channel_id))
    : recentMessages
  const visiblePendingPreview = inactiveChannelIds.length
    ? pendingPreview.filter((row) => !inactiveChannelIds.includes(row.channel_id))
    : pendingPreview

  // If cooldown filtering removed everything, skip this batch (leave items
  // pending) rather than waking the agent with an empty digest.
  if (visibleRecentMessages.length === 0 && visiblePendingPreview.length === 0) return null

  const replyContextByMessageId = buildReplyTargetContextMap([...visibleRecentMessages, ...visiblePendingPreview])
  const hasImages = [...visibleRecentMessages, ...visiblePendingPreview].some(
    (row) => extractImageAttachmentsFromRawJson(row.raw_json).length > 0,
  )

  const lines: string[] = [
    `[discord batch] ${formatBatchTimestamp(from)} -> ${formatBatchTimestamp(nowIso)}`,
    "channel messages are context, not direct requests. replying is optional; use judgment.",
    ...(hasImages
      ? ["image attachments appear as [images: <discord cdn urls>]; download with shell, then inspect with image_tool if useful."]
      : []),
    "",
    "recent messages:",
  ]

  for (const row of visibleRecentMessages) {
    const label = channelLabel(row)
    const pronounsSuffix = row.pronouns ? ` (${row.pronouns})` : ""
    const author = row.author_username ? `@${row.author_username}${pronounsSuffix}` : "@unknown"
    const ts = formatBatchTimestamp(row.created_at)
    const replyTo = replyContextByMessageId.get(row.message_id)
    lines.push(`- source_item_id=${row.message_id} [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}: ${fullMessageText(row.content)}${formatBatchImages(row.raw_json)}`)
  }

  if (truncated) {
    lines.push(`- ...truncated at ${maxMessages} messages`)
  }

  lines.push("")
  lines.push("pending preview:")
  if (visiblePendingPreview.length === 0) {
    lines.push("- (none)")
  } else {
    for (const row of visiblePendingPreview) {
      const label = channelLabel(row)
      const pronounsSuffix = row.pronouns ? ` (${row.pronouns})` : ""
      const author = row.author_username ? `@${row.author_username}${pronounsSuffix}` : "@unknown"
      const ts = formatBatchTimestamp(row.created_at)
      const replyTo = replyContextByMessageId.get(row.message_id)
      lines.push(`- source_item_id=${row.item_id} bucket=${row.bucket} [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}: ${compactText(row.content, 120)}${formatBatchImages(row.raw_json)}`)
    }
  }

  lines.push("")
  lines.push("you can reply if useful via discord_send using source_item_id from the target message, or choose not to reply.")

  // Only mark items we actually surfaced as seen. Inactive cooldown-channel
  // items are left `pending` so they reappear once their window opens.
  for (const row of visiblePendingPreview) {
    updateInboxItem(row.item_id, "seen", "noted", "auto-seen after inclusion in Discord batch context")
  }

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
    if (/^\d+$/.test(ref)) {
      return messageExistsById(ref) ? ref : null
    }

    const byContent = findMessageByContent(channelId, `%${ref}%`)
    if (byContent) return byContent

    const byUsername = findMessageByUsername(channelId, `%${ref}%`)
    if (byUsername) return byUsername

    return null
  }

  return resolveSourceMessageId(sourceItemId)
}

function resolveSourceMessageId(sourceItemId?: string): string | null {
  const safeSourceItemId = sourceItemId?.trim()
  if (!safeSourceItemId) return null
  return getItemMessageId(safeSourceItemId) ?? (messageExistsById(safeSourceItemId) ? safeSourceItemId : null)
}

function resolveSourceChannelId(sourceItemId?: string): string | null {
  const sourceMessageId = resolveSourceMessageId(sourceItemId)
  if (!sourceMessageId) return null
  return getMessageForReference(sourceMessageId)?.channel_id?.trim() || null
}

const AUTO_REPLY_STALE_MINUTES = 10

function shouldUseExplicitReference(channelId: string, sourceMessageId: string): boolean {
  const source = getMessageForReference(sourceMessageId)

  if (!source?.message_id || !source.channel_id) return false
  if (source.channel_id !== channelId) return false

  const createdMs = Date.parse(source.created_at ?? "")
  if (Number.isFinite(createdMs)) {
    const staleMs = AUTO_REPLY_STALE_MINUTES * 60_000
    if (Date.now() - createdMs >= staleMs) return true
  }

  const intervening = countInterveningMessages(channelId, sourceMessageId, source.author_id ?? "")
  return intervening > 0
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
  return findPendingDmItemId(channelId)
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
  attachments?: Array<{ path: string; name?: string; description?: string }>
}): Promise<Record<string, unknown>> {
  let channelId = String(params.channelId ?? "").trim()
  if (!channelId && params.sourceItemId?.trim()) {
    channelId = getItemChannelId(params.sourceItemId.trim()) ?? resolveSourceChannelId(params.sourceItemId) ?? ""
  }
  if (!channelId) throw new Error("channel_id is required (or provide source_item_id that maps to one)")

  const content = String(params.content ?? "").trim()
  if (!content) throw new Error("content is required")

  const replyMode = normalizeReplyMode(params.replyMode)
  const explicitSourceItemId = params.sourceItemId?.trim() ? params.sourceItemId.trim() : null
  const inferredSourceItemId = explicitSourceItemId ? null : inferPendingDmItemId(channelId)
  const resolvedSourceItemId = explicitSourceItemId ?? inferredSourceItemId
  const resolvedSourceMessageId = resolveSourceMessageId(resolvedSourceItemId ?? undefined)
  const referenceMessageId = await chooseMessageReference({
    channelId,
    replyMode,
    sourceItemId: resolvedSourceItemId ?? undefined,
    referenceMessage: params.referenceMessage,
  })

  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const filesArray = params.attachments?.map((att) => {
    const resolvedPath = path.resolve(att.path)
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Attachment file not found at path: ${att.path}`)
    }
    return {
      name: att.name || path.basename(resolvedPath),
      data: fs.readFileSync(resolvedPath),
    }
  })

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
        ...(params.attachments
          ? {
              attachments: params.attachments.map((att, index) => ({
                id: index,
                description: att.description,
                filename: att.name || path.basename(att.path),
              })),
            }
          : {}),
      },
      files: filesArray,
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

  if (resolvedSourceItemId && getItemMessageId(resolvedSourceItemId)) {
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
    resolved_source_message_id: resolvedSourceMessageId,
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
