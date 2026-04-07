import type { UserMessage } from "../types.js"

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
  const isDm =
    Boolean(b.is_dm) ||
    channelType === 1 ||
    channelType === 3 ||
    (message.guild_id == null && b.guild_id == null && channel?.guild_id == null)

  const content =
    String(message.content ?? b.content ?? "").trim() ||
    "(no text content)"
  const authorName = String(author?.global_name ?? author?.username ?? b.author_username ?? b.author ?? "unknown")
  const channelId = String(message.channel_id ?? b.channel_id ?? channel?.id ?? "unknown")
  const messageId = String(message.id ?? b.message_id ?? "unknown")

  return {
    source: "discord",
    triggeredAt: new Date().toISOString(),
    content: `[discord${isDm ? "/dm" : ""}] @${authorName} in ${channelId} (${messageId})\n\n${content}`,
    raw: body,
  }
}
