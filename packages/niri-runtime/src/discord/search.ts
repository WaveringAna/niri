/**
 * Discord message search — exact lookup plus background semantic indexing.
 *
 * @module discord/search
 */

import { createHash } from "crypto"
import { getDb, isVecAvailable, MEMORY_EMBEDDING_DIMENSIONS } from "../db"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embeddingsConfigured, embedTexts } from "../embeddings"

const DISCORD_EMBEDDING_BATCH_SIZE = Math.max(
  1,
  Math.min(512, Number.parseInt(process.env.DISCORD_EMBEDDING_BATCH_SIZE ?? "64", 10) || 64),
)
const DISCORD_SEARCH_CATCHUP_BATCH_SIZE = Math.max(
  0,
  Math.min(128, Number.parseInt(process.env.DISCORD_SEARCH_CATCHUP_BATCH_SIZE ?? "16", 10) || 16),
)
const DISCORD_EMBEDDING_IDLE_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DISCORD_EMBEDDING_IDLE_MS ?? "30000", 10) || 30_000,
)
const DISCORD_EMBEDDING_RETRY_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DISCORD_EMBEDDING_RETRY_MS ?? "60000", 10) || 60_000,
)

type DiscordSearchRow = {
  message_id: string
  channel_id: string
  guild_id: string | null
  author_id: string | null
  author_username: string | null
  content: string
  created_at: string
  is_dm: number
  mentions_bot: number
  is_from_bot: number
  guild_name: string | null
  channel_name: string | null
}

type DiscordEmbeddingRow = DiscordSearchRow & {
  model: string | null
  dimensions: number | null
  content_hash: string | null
}

type PendingDiscordEmbeddingRow = DiscordEmbeddingRow & {
  embedding_text: string
  next_hash: string
}

export type DiscordEmbeddingSyncResult = {
  embedded: number
  selected: number
  skipped?: string
}

export type DiscordEmbeddingBackfillHandle = {
  stop: () => void
}

function embeddingHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function vectorParam(vector: number[]): Float32Array {
  return new Float32Array(vector)
}

function embeddingText(row: DiscordSearchRow): string {
  const location = row.is_dm === 1
    ? `dm:${row.channel_id}`
    : [row.guild_name ?? row.guild_id, row.channel_name ? `#${row.channel_name}` : row.channel_id]
        .filter(Boolean)
        .join("/")
  return [
    `channel: ${location}`,
    row.author_username ? `author: @${row.author_username}` : null,
    `time: ${row.created_at}`,
    row.content,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n")
}

function formatHumanTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown time"
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

function publicRow(row: DiscordSearchRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: row.message_id,
    source_item_id: row.message_id,
    channel_id: row.channel_id,
    guild_id: row.guild_id,
    guild_name: row.guild_name,
    channel_name: row.channel_name,
    author_id: row.author_id,
    author_username: row.author_username,
    content: row.content,
    created_at: formatHumanTimestamp(row.created_at),
    is_dm: row.is_dm === 1,
    mentions_bot: row.mentions_bot === 1,
    is_from_bot: row.is_from_bot === 1,
    ...extra,
  }
}

function getMessage(channelId: string, messageId: string): DiscordSearchRow | null {
  const db = getDb()
  const row = db
    .prepare(
      `select
         m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
         m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
         c.guild_name, c.channel_name
       from discord_messages m
       left join discord_channels c on c.channel_id = m.channel_id
       where m.channel_id = ? and m.message_id = ?`,
    )
    .get(channelId, messageId) as DiscordSearchRow | undefined
  return row ?? null
}

function discordEmbeddingUnavailableReason(): string | null {
  if (!isVecAvailable()) return "sqlite-vec unavailable"
  if (!embeddingsConfigured()) return "embeddings disabled: set EMBEDDING_API_KEY"
  if (EMBEDDING_DIMENSIONS !== MEMORY_EMBEDDING_DIMENSIONS) {
    return `embedding dimension mismatch: configured ${EMBEDDING_DIMENSIONS}, expected ${MEMORY_EMBEDDING_DIMENSIONS}`
  }
  return null
}

let orphanCleanupDone = false

function cleanupDiscordEmbeddingOrphans(): void {
  if (orphanCleanupDone) return
  const db = getDb()
  db.prepare("delete from discord_message_embedding_meta where message_id not in (select message_id from discord_messages)").run()
  db.prepare("delete from discord_message_vec where rowid not in (select cast(message_id as integer) from discord_messages)").run()
  orphanCleanupDone = true
}

/**
 * Embeds one bounded batch of pending Discord messages.
 *
 * Repeated calls continue through the backlog. This is deliberately batch-based
 * for checkpointing; the startup backfill loop calls it continuously.
 */
export async function syncDiscordMessageEmbeddingsBatch(params?: {
  channelId?: string
  limit?: number
}): Promise<DiscordEmbeddingSyncResult> {
  const skipped = discordEmbeddingUnavailableReason()
  if (skipped) return { embedded: 0, selected: 0, skipped }

  cleanupDiscordEmbeddingOrphans()

  const channelId = String(params?.channelId ?? "").trim()
  const limit = Math.max(1, Math.min(512, Math.trunc(params?.limit ?? DISCORD_EMBEDDING_BATCH_SIZE) || DISCORD_EMBEDDING_BATCH_SIZE))
  const db = getDb()
  const rows = db
    .prepare(
      `select
         m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
         m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
         c.guild_name, c.channel_name,
         e.model, e.dimensions, e.content_hash
       from discord_messages m
       left join discord_channels c on c.channel_id = m.channel_id
       left join discord_message_embedding_meta e on e.message_id = m.message_id
       where (? = '' or m.channel_id = ?)
         -- sqlite-vec rowids are integers; synthetic/test message ids are not.
         and m.message_id <> ''
         and m.message_id not glob '*[^0-9]*'
         and (
           e.message_id is null
           or e.model != ?
           or e.dimensions != ?
         )
       order by cast(m.message_id as integer) asc
       limit ?`,
    )
    .all(channelId, channelId, EMBEDDING_MODEL, MEMORY_EMBEDDING_DIMENSIONS, limit) as DiscordEmbeddingRow[]

  const pending = rows
    .map((row) => {
      const text = embeddingText(row)
      return { ...row, embedding_text: text, next_hash: embeddingHash(text) }
    })
    .filter(
      (row) =>
        row.model !== EMBEDDING_MODEL ||
        row.dimensions !== MEMORY_EMBEDDING_DIMENSIONS ||
        row.content_hash !== row.next_hash,
    )

  if (pending.length === 0) return { embedded: 0, selected: rows.length }

  const upsertMeta = db.prepare(`
    insert into discord_message_embedding_meta (message_id, model, dimensions, content_hash, updated_at)
    values (?, ?, ?, ?, datetime('now'))
    on conflict(message_id) do update set
      model = excluded.model,
      dimensions = excluded.dimensions,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
  `)
  const upsertVector = db.prepare("insert or replace into discord_message_vec(rowid, embedding) values (?, ?)")

  let embedded = 0
  const embedPendingRows = async (batch: PendingDiscordEmbeddingRow[]): Promise<void> => {
    try {
      const vectors = await embedTexts(batch.map((row) => row.embedding_text))
      db.transaction(() => {
        batch.forEach((row, index) => {
          const vector = vectors[index]
          if (!vector) return
          if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS) {
            throw new Error(`embedding dimension mismatch: got ${vector.length}, expected ${MEMORY_EMBEDDING_DIMENSIONS}`)
          }
          upsertVector.run(BigInt(row.message_id), vectorParam(vector))
          upsertMeta.run(row.message_id, EMBEDDING_MODEL, MEMORY_EMBEDDING_DIMENSIONS, row.next_hash)
          embedded += 1
        })
      })()
    } catch (err) {
      if (batch.length <= 1) throw err
      const midpoint = Math.ceil(batch.length / 2)
      console.warn(
        `[discord embeddings] batch of ${batch.length} failed; retrying as ${midpoint}+${batch.length - midpoint}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await embedPendingRows(batch.slice(0, midpoint))
      await embedPendingRows(batch.slice(midpoint))
    }
  }

  await embedPendingRows(pending)

  return { embedded, selected: rows.length }
}

/**
 * Starts a non-blocking worker that continuously embeds pending Discord
 * messages until caught up, then wakes periodically for new messages.
 */
export function startDiscordEmbeddingBackfill(): DiscordEmbeddingBackfillHandle {
  const enabled = (process.env.DISCORD_EMBEDDING_BACKFILL ?? "true").trim().toLowerCase() !== "false"
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let batches = 0
  let totalEmbedded = 0
  let loggedIdle = false
  let loggedSkip: string | null = null

  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, delayMs)
    if (typeof timer.unref === "function") timer.unref()
  }

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const result = await syncDiscordMessageEmbeddingsBatch()
      if (result.skipped) {
        if (loggedSkip !== result.skipped) {
          console.warn(`[discord embeddings] skipped: ${result.skipped}`)
          loggedSkip = result.skipped
        }
        schedule(DISCORD_EMBEDDING_IDLE_MS)
        return
      }

      if (result.embedded > 0) {
        batches += 1
        totalEmbedded += result.embedded
        loggedIdle = false
        if (batches === 1 || batches % 10 === 0) {
          console.log(`[discord embeddings] backfill embedded=${totalEmbedded} latest_batch=${result.embedded}`)
        }
        schedule(0)
        return
      }

      if (!loggedIdle) {
        console.log(`[discord embeddings] caught up embedded=${totalEmbedded}`)
        loggedIdle = true
      }
      schedule(DISCORD_EMBEDDING_IDLE_MS)
    } catch (err) {
      console.warn(`[discord embeddings] backfill failed: ${err instanceof Error ? err.message : String(err)}`)
      schedule(DISCORD_EMBEDDING_RETRY_MS)
    } finally {
      running = false
    }
  }

  if (!enabled) {
    console.log("[discord embeddings] backfill disabled")
    return { stop: () => {} }
  }

  schedule(0)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

function keywordDiscordSearch(channelId: string, query: string, limit: number): Record<string, unknown>[] {
  const db = getDb()
  const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean).slice(0, 8)
  const pattern = `%${terms.join("%")}%`
  const rows = db
    .prepare(
      `select
         m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
         m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
         c.guild_name, c.channel_name
       from discord_messages m
       left join discord_channels c on c.channel_id = m.channel_id
       where m.channel_id = ? and m.content like ?
       order by cast(m.message_id as integer) desc
       limit ?`,
    )
    .all(channelId, pattern, limit) as DiscordSearchRow[]
  return rows.map((row) => publicRow(row, { match: "keyword" }))
}

async function semanticDiscordSearch(channelId: string, query: string, limit: number): Promise<Record<string, unknown>[]> {
  const skipped = discordEmbeddingUnavailableReason()
  if (skipped) return keywordDiscordSearch(channelId, query, limit)
  if (DISCORD_SEARCH_CATCHUP_BATCH_SIZE > 0) {
    await syncDiscordMessageEmbeddingsBatch({ channelId, limit: DISCORD_SEARCH_CATCHUP_BATCH_SIZE })
  }

  const [vector] = await embedTexts([query])
  if (!vector) return keywordDiscordSearch(channelId, query, limit)

  const db = getDb()
  const rows = db
    .prepare(
      `select
         m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
         m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
         c.guild_name, c.channel_name,
         v.distance
       from discord_message_vec v
       join discord_messages m on m.message_id = cast(v.rowid as text)
       left join discord_channels c on c.channel_id = m.channel_id
       where v.embedding match ? and k = ?
       order by v.distance`,
    )
    .all(vectorParam(vector), Math.max(limit * 200, 1000)) as Array<DiscordSearchRow & { distance: number }>

  const results = rows
    .filter((row) => row.channel_id === channelId)
    .slice(0, limit)
    .map((row) => publicRow(row, {
      match: "semantic",
      semantic_distance: row.distance,
      semantic_similarity: 1 - row.distance,
    }))

  return results.length > 0 ? results : keywordDiscordSearch(channelId, query, limit)
}

/**
 * Searches stored Discord messages by exact message id or semantic query.
 *
 * @param params - Channel plus either message id or query.
 * @returns Search result payload.
 */
export async function searchDiscordMessages(params: {
  channelId: string
  query?: string
  messageId?: string
  limit?: number
}): Promise<Record<string, unknown>> {
  const channelId = String(params.channelId ?? "").trim()
  if (!channelId) throw new Error("channel_id is required")

  const messageId = String(params.messageId ?? "").trim()
  const query = String(params.query ?? "").trim()
  const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 10) || 10))

  if (messageId) {
    const row = getMessage(channelId, messageId)
    return {
      ok: true,
      channel_id: channelId,
      message_id: messageId,
      results: row ? [publicRow(row, { match: "message_id" })] : [],
    }
  }

  if (!query) throw new Error("query or message_id is required")

  const results = await semanticDiscordSearch(channelId, query, limit)
  return {
    ok: true,
    channel_id: channelId,
    query,
    results,
  }
}
