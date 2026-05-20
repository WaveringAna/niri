/**
 * Safe type-coercion helpers and Discord payload parsers.
 *
 * @module discord/parse
 */

export type DiscordObject = Record<string, unknown>

export type DiscordMessageRecord = {
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

export type DiscordChannelRecord = {
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

/**
 * Coerces an unknown value to a plain object, returning `null` for non-objects and arrays.
 *
 * @param value - Value to coerce.
 * @returns Plain object or `null`.
 */
export function asObject(value: unknown): DiscordObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DiscordObject) : null
}

/**
 * Coerces an unknown value to a non-empty trimmed string.
 *
 * @param value - Value to coerce.
 * @returns Trimmed string or `null`.
 */
export function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Coerces an unknown value to a boolean.
 *
 * @param value - Value to coerce.
 * @returns Boolean interpretation.
 */
export function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes"
  }
  return false
}

/**
 * Coerces an unknown value to a finite number.
 *
 * @param value - Value to coerce.
 * @returns Finite number or `null`.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Coerces an unknown value to an ISO-8601 timestamp string.
 *
 * @param value - Value to coerce.
 * @returns ISO string, falling back to now on failure.
 */
export function toIsoString(value: unknown): string {
  const raw = asString(value)
  if (!raw) return new Date().toISOString()
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

/**
 * Parses a comma-separated or array channel-id input into a normalized array.
 *
 * @param input - Channel ids as string, array, or env var.
 * @returns Array of trimmed channel id strings.
 */
export function parseChannelIds(input?: string[] | string | null): string[] {
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter(Boolean)
  }

  const text = typeof input === "string" ? input : process.env.DISCORD_SCAN_CHANNEL_IDS ?? ""
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * Returns the set of configured channel ids for inbox detection.
 *
 * @param input - Optional override channel ids.
 * @returns Set of configured channel id strings.
 */
export function configuredChannelIdSet(input?: string[] | string | null): Set<string> {
  return new Set(parseChannelIds(input))
}

export type DiscordImageAttachment = {
  url: string
  filename: string | null
  contentType: string | null
}

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif)$/i

/**
 * Determines whether a Discord attachment object is an image.
 *
 * @param attachment - Attachment object from a Discord message.
 * @returns `true` when the attachment is an image by content-type or filename.
 */
function isImageAttachment(attachment: DiscordObject): boolean {
  const contentType = asString(attachment.content_type)
  if (contentType && contentType.toLowerCase().startsWith("image/")) return true
  const name = asString(attachment.filename) ?? asString(attachment.url)
  if (!name) return false
  const pathPart = name.split("?")[0] ?? name
  return IMAGE_EXTENSION_RE.test(pathPart)
}

/**
 * Extracts image attachment CDN links from a Discord message object.
 *
 * Accepts either a raw event payload (with a `message` wrapper) or a message
 * object directly. Returns the Discord CDN url for each image attachment so the
 * agent can download it and run its own image tool on it.
 *
 * @param payload - Raw event payload or message object.
 * @returns Array of image attachments with CDN urls.
 */
export function extractImageAttachments(payload: unknown): DiscordImageAttachment[] {
  const root = asObject(payload)
  if (!root) return []
  const message = asObject(root.message) ?? root
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const out: DiscordImageAttachment[] = []
  for (const entry of attachments) {
    const attachment = asObject(entry)
    if (!attachment || !isImageAttachment(attachment)) continue
    const url = asString(attachment.url) ?? asString(attachment.proxy_url)
    if (!url) continue
    out.push({
      url,
      filename: asString(attachment.filename),
      contentType: asString(attachment.content_type),
    })
  }
  return out
}

/**
 * Extracts image attachment CDN links from a stored raw JSON payload.
 *
 * @param rawJson - Stored raw JSON for a Discord message.
 * @returns Array of image attachments, empty on parse failure.
 */
export function extractImageAttachmentsFromRawJson(rawJson: string): DiscordImageAttachment[] {
  try {
    return extractImageAttachments(JSON.parse(rawJson))
  } catch {
    return []
  }
}

/**
 * Parses a raw Discord gateway/webhook payload into a structured message record.
 *
 * @param payload - Raw event payload.
 * @param botUserId - Optional bot user id for self-detection.
 * @returns Parsed record, or `null` when the payload lacks identity fields.
 */
export function parseMessageRecord(payload: unknown, botUserId?: string): DiscordMessageRecord | null {
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
    guildId == null
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

/**
 * Parses a raw Discord channel payload into a structured channel record.
 *
 * @param payload - Raw event payload.
 * @param fallback - Optional fallback values for ambiguous payloads.
 * @returns Parsed record, or `null` when the payload lacks a channel id.
 */
export function parseChannelRecord(
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
  const isDm = asBoolean(root.is_dm) || channelType === 1 || channelType === 3 || fallback?.isDm === true || guildId == null
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
