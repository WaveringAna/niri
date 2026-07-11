/**
 * Discord-specific memory query parsing.
 *
 * Extracts structured sender/source/body parts from formatted Discord
 * trigger messages so the memory search pipeline can use them as signals.
 *
 * @module memory/discord-query
 */

import { normalizeHandle } from "./shared"
import { getDb } from "../db"

export type MemoryQueryParts = {
  sender: string | null
  source: string | null
  body: string
}

// ── wake envelope stripping ────────────────────────────────────────────

const WAKE_ENVELOPE_PATTERN = /^\[(wake|incoming|harness restarted)[^\n]*\]\s*/gi

/**
 * Strips leading `[wake]` / `[incoming]` / `[harness restarted]` envelopes from raw message content.
 *
 * @param raw - Raw message content.
 * @returns Content without the leading envelope.
 */
export function stripWakeEnvelope(raw: string): string {
  return raw.replace(WAKE_ENVELOPE_PATTERN, "").trim()
}

// ── discord channel label ──────────────────────────────────────────────

/**
 * Resolves a human-readable channel label from the discord channels table.
 *
 * @param channelId - Discord channel id.
 * @param fallbackContext - Raw context string from the trigger message.
 * @param isDm - Whether the message is a DM.
 * @returns Short label like `"DM"`, `"guild/#channel"`, or `"#channel"`.
 */
export function discordChannelLabel(channelId: string | null, fallbackContext: string | null, isDm: boolean): string {
  if (isDm) return "DM"

  const fallback = fallbackContext
    ?.replace(/^context:\s*/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim()

  if (channelId) {
    try {
      const row = getDb()
        .prepare("select guild_id, guild_name, channel_name, is_dm from discord_channels where channel_id = ?")
        .get(channelId) as
        | {
            guild_id: string | null
            guild_name: string | null
            channel_name: string | null
            is_dm: number
          }
        | undefined

      if (row?.is_dm) return "DM"
      if (row) {
        const guild = row.guild_name ?? row.guild_id
        const channel = row.channel_name ?? channelId
        if (guild && channel) return `${guild}/#${channel}`
        if (channel) return `#${channel}`
      }
    } catch {
      // If the main db is unavailable in tests or scripts, keep the parsed context.
    }
  }

  if (fallback) return fallback
  return channelId ? `#${channelId}` : "channel"
}

// ── single discord DM/channel message ──────────────────────────────────

/**
 * Parses a single discord DM or channel trigger message into structured parts.
 *
 * @param raw - Raw trigger message content.
 * @returns Parsed parts, or `null` when the message is not a discord trigger.
 */
export function conciseDiscordMemoryQuery(raw: string): MemoryQueryParts | null {
  const withoutWakeEnvelope = stripWakeEnvelope(raw)
  if (!/\[discord\/(?:dm|channel)\]/i.test(withoutWakeEnvelope)) return null

  const blocks = withoutWakeEnvelope
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
  const headerBlock = blocks[0] ?? withoutWakeEnvelope
  const message = blocks.length > 1 ? blocks.slice(1).join("\n\n").trim() : ""

  const lines = headerBlock.split("\n").map((line) => line.trim()).filter(Boolean)
  const discordLine = lines.find((line) => /^\[discord\/(?:dm|channel)\]/i.test(line)) ?? ""
  const contextLine = lines.find((line) => /^context:\s*/i.test(line)) ?? null
  const isDm = /\[discord\/dm\]/i.test(discordLine)
  const author = discordLine.match(/@(\S+)/)?.[1] ?? null
  const context = contextLine?.replace(/^context:\s*/i, "").trim() ?? ""
  const dmChannelId = context.match(/^DM\s+(\d+)/i)?.[1] ?? null
  const namedChannelId = context.match(/\((\d+)\)\s*$/)?.[1] ?? null
  const channelId = dmChannelId ?? namedChannelId
  const location = discordChannelLabel(channelId, contextLine, isDm)

  if (!author && !location && !message) return null
  return {
    sender: author ? normalizeHandle(author) : null,
    source: location || null,
    body: message,
  }
}

// ── discord batch digest ───────────────────────────────────────────────

function extractBulletSection(raw: string, label: string): string[] {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = raw.match(new RegExp(`(?:^|\\n)${escapedLabel}:\\n([\\s\\S]*?)(?:\\n\\n[^\\n:]+:|$)`, "i"))
  if (!match) return []

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && line !== "(none)")
}

/**
 * Parses a discord batch digest trigger message into structured parts.
 *
 * @param raw - Raw trigger message content.
 * @returns Parsed parts from the pending preview entries, or `null`.
 */
export function conciseDiscordBatchMemoryQuery(raw: string): MemoryQueryParts | null {
  const withoutWakeEnvelope = stripWakeEnvelope(raw)
  if (!/\[discord batch\]/i.test(withoutWakeEnvelope)) return null

  const pending = extractBulletSection(withoutWakeEnvelope, "pending preview")
  let selected = pending.filter((entry) => !/^\(none\)$/i.test(entry)).slice(-3)
  if (selected.length === 0) {
    const recent = extractBulletSection(withoutWakeEnvelope, "recent messages")
    selected = recent.filter((entry) => !/^\(none\)$/i.test(entry)).slice(-3)
  }
  if (selected.length === 0) return null

  const senders: string[] = []
  const sources: string[] = []
  const bodies: string[] = []
  const entryPattern = /(?:^|\s)\[([^\]]+)\]\s+\[[^\]]+\]\s+@([^:]+):\s*(.*)$/i
  for (const entry of selected) {
    const match = entry.match(entryPattern)
    if (!match) {
      bodies.push(entry)
      continue
    }
    const [, location, author, body] = match
    if (author) senders.push(normalizeHandle(author))
    if (location) sources.push(location.trim())
    if (body) bodies.push(body.trim())
  }

  const lastSender = senders.length > 0 ? senders[senders.length - 1]! : null
  const lastSource = sources.length > 0 ? sources[sources.length - 1]! : null
  const body = bodies.filter(Boolean).join("\n").trim()

  if (!lastSender && !lastSource && !body) return null
  return { sender: lastSender, source: lastSource, body }
}

// ── unified query parser ───────────────────────────────────────────────

/**
 * Parses a raw trigger message into structured memory query parts.
 *
 * Tries discord-specific parsers first, then falls back to treating
 * the full content (minus wake envelope) as the query body.
 *
 * @param raw - Raw trigger message content.
 * @returns Structured query parts.
 */
export function memoryQueryForUserMessage(raw: string): MemoryQueryParts {
  return (
    conciseDiscordMemoryQuery(raw) ??
    conciseDiscordBatchMemoryQuery(raw) ??
    { sender: null, source: null, body: stripWakeEnvelope(raw) }
  )
}

/**
 * Serializes query parts back into a search string.
 *
 * @param parts - Structured query parts.
 * @returns Concatenated sender + body string.
 */
export function memoryQueryToString(parts: MemoryQueryParts): string {
  const pieces = [
    parts.sender ? `@${parts.sender}` : null,
    parts.body || null,
  ].filter((value): value is string => Boolean(value && value.trim()))
  return pieces.join("\n")
}
