import type { UserMessage } from "../types.js"
import { getDb } from "../db.js"

function asIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function referencedMessageId(message: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const reference =
    asRecord(message.message_reference) ??
    asRecord(body.message_reference) ??
    asRecord(message.reference) ??
    asRecord(body.reference)
  return asString(reference?.message_id) ?? asString(reference?.messageId) ?? asString(reference?.id)
}

function embeddedReferencedMessage(
  message: Record<string, unknown>,
  body: Record<string, unknown>,
): { message_id: string; author_username: string | null; content: string } | null {
  const referenced = asRecord(message.referenced_message) ?? asRecord(body.referenced_message)
  if (!referenced) return null

  const messageId = asString(referenced.id)
  if (!messageId) return null

  const author = asRecord(referenced.author)
  return {
    message_id: messageId,
    author_username: asString(author?.global_name) ?? asString(author?.username),
    content: String(referenced.content ?? ""),
  }
}

function replyContextLine(message: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const refId = referencedMessageId(message, body)
  if (!refId) return null

  const db = getDb()
  const stored = db
    .prepare(
      `select message_id, author_username, content
       from discord_messages
       where message_id = ?`,
    )
    .get(refId) as { message_id: string; author_username: string | null; content: string } | undefined
  const reply = stored ?? embeddedReferencedMessage(message, body) ?? {
    message_id: refId,
    author_username: null,
    content: "",
  }
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return `reply_to: ${author} msg/${reply.message_id}: ${JSON.stringify(reply.content)}`
}

export function fromDiscord(body: unknown): UserMessage {
  const b = body as Record<string, unknown>
  const message = (typeof b.message === "object" && b.message
    ? (b.message as Record<string, unknown>)
    : b) as Record<string, unknown>
  const author =
    typeof message.author === "object" && message.author
      ? (message.author as Record<string, unknown>)
      : null
  const channel =
    typeof b.channel === "object" && b.channel
      ? (b.channel as Record<string, unknown>)
      : null

  const channelType = Number(message.channel_type ?? b.channel_type ?? channel?.type ?? NaN)
  const guildId = String(message.guild_id ?? b.guild_id ?? channel?.guild_id ?? "").trim()
  const guildName = String((b.guild_name ?? channel?.guild_name ?? guildId) || "").trim()
  const channelName = String(channel?.name ?? b.channel_name ?? "").trim()
  const isDm =
    Boolean(b.is_dm) ||
    channelType === 1 ||
    channelType === 3 ||
    (!guildId && Number.isNaN(channelType))

  const content =
    String(message.content ?? b.content ?? "").trim() ||
    "(no text content)"
  const triggeredAt = new Date().toISOString()
  const timestamp = asIsoTimestamp(message.timestamp ?? b.timestamp, triggeredAt)
  const authorName = String(author?.global_name ?? author?.username ?? b.author_username ?? b.author ?? "unknown")
  const channelId = String(message.channel_id ?? b.channel_id ?? channel?.id ?? "unknown")
  const messageId = String(message.id ?? b.message_id ?? "unknown")
  const location = isDm
    ? `DM ${channelId}`
    : `${guildName || guildId || "unknown server"}/#${channelName || channelId} (${channelId})`
  const header = isDm ? "[discord/dm]" : "[discord/channel]"
  const action = isDm
    ? "This is a direct message. Reply if it needs a response."
    : "This is a server channel message, not a DM. You may choose not to reply; only respond if useful."
  const replyLine = replyContextLine(message, b)

  return {
    source: "discord",
    triggeredAt,
    content: `${header} @${authorName}\ncontext: ${location}\nmessage_id: ${messageId}\ntimestamp: ${timestamp}${replyLine ? `\n${replyLine}` : ""}\naction: ${action}\n\n${content}`,
    raw: body,
  }
}
