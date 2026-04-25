import type { UserMessage } from "../types.js"

function asIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
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

  return {
    source: "discord",
    triggeredAt,
    content: `${header} @${authorName}\ncontext: ${location}\nmessage_id: ${messageId}\ntimestamp: ${timestamp}\naction: ${action}\n\n${content}`,
    raw: body,
  }
}
