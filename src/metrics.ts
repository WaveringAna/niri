import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type OpenAI from "openai"
import { getDb } from "./db.js"
import type { Message } from "./types.js"
import type { MemorySearchResult } from "./memory.js"

export interface BaseMetricEvent {
  timestamp: string
}

export interface PromptMetric extends BaseMetricEvent {
  type: "prompt"
  messages: Message[]
}

export interface PromptResponseMetric extends BaseMetricEvent {
  type: "prompt_response"
  promptMetricId?: number
  model: string
  toolChoice?: string
  messages: Message[]
  response: OpenAI.Chat.ChatCompletionMessage
  usage?: OpenAI.Completions.CompletionUsage
}

export interface MemoryMetric extends BaseMetricEvent {
  type: "memory"
  query: string
  results: MemorySearchResult[]
}

export interface CompactionMetric extends BaseMetricEvent {
  type: "compaction"
  before: number
  after: number
  method: string
  summary?: string
}

export interface UsageMetric extends BaseMetricEvent {
  type: "usage"
  usage: OpenAI.Completions.CompletionUsage
}

export type MetricEvent = PromptMetric | PromptResponseMetric | MemoryMetric | CompactionMetric | UsageMetric

export type MetricListType = "prompt_response" | "summarization" | "memory" | "prompt" | "usage" | "discord"
export type MetricBucketName = "memories" | "summarization" | "prompt_response" | "prompt" | "usage" | "discord"

export type MetricListItem =
  | (BaseMetricListItem & {
      type: "prompt_response"
      promptMetricId?: number
      model?: string
      toolChoice?: string
      messageCount?: number
      lastUserMessage?: string
      responsePreview?: string
      toolCallCount?: number
      usage?: OpenAI.Completions.CompletionUsage
    })
  | (BaseMetricListItem & {
      type: "summarization"
      method?: string
      before?: number
      after?: number
      savedTokens?: number
      summaryPreview?: string
      summaryChars?: number
    })
  | (BaseMetricListItem & {
      type: "memory"
      queryPreview?: string
      resultCount?: number
    })
  | (BaseMetricListItem & {
      type: "prompt"
      messageCount?: number
      lastUserMessage?: string
    })
  | (BaseMetricListItem & {
      type: "usage"
      usage?: OpenAI.Completions.CompletionUsage
    })

export interface BaseMetricListItem extends BaseMetricEvent {
  id: number
  sourceType: MetricEvent["type"]
  detailPath: string
}

export interface MetricsQuery {
  limit?: number
  cursor?: number
  cursors?: Partial<Record<MetricBucketName, string | number>>
  type?: MetricListType[]
  includeRaw?: boolean
  q?: string
  from?: string
  to?: string
}

export interface DiscordMetricListItem extends BaseMetricEvent {
  id: string
  type: "discord"
  sourceType: "discord"
  detailPath: string
  messageId: string
  channelId: string
  guildId?: string
  authorId?: string
  authorUsername?: string
  contentPreview?: string
  isDm: boolean
  mentionsBot: boolean
  isFromBot: boolean
}

export interface MetricsPage {
  memories: MetricListItem[]
  summarization: MetricListItem[]
  prompt_response: MetricListItem[]
  prompt: MetricListItem[]
  usage: MetricListItem[]
  discord: DiscordMetricListItem[]
  limit: number
  nextCursor: Partial<Record<MetricBucketName, string | number>>
  hasMore: Partial<Record<MetricBucketName, boolean>>
  filters: {
    type?: MetricListType[]
    includeRaw: boolean
    q?: string
    from?: string
    to?: string
  }
}

export type MetricEventInput =
  | Omit<PromptMetric, "timestamp">
  | Omit<PromptResponseMetric, "timestamp">
  | Omit<MemoryMetric, "timestamp">
  | Omit<CompactionMetric, "timestamp">
  | Omit<UsageMetric, "timestamp">

interface MetricRow {
  id: number
  type: string
  payload: string
  createdAt: string
}

const HOME_DIR = path.resolve(fileURLToPath(import.meta.url), "../../home")
const DB_PATH = path.join(HOME_DIR, "metrics.db")

let db: Database.Database
const events: (MetricEvent & { id: number })[] = []
const MAX_IN_MEMORY = 100

export function initMetricsDb(): void {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true })
    fs.accessSync(HOME_DIR, fs.constants.W_OK)
  } catch (err: any) {
    let owner = "unknown"
    try {
      const st = fs.statSync(HOME_DIR)
      owner = `${st.uid}:${st.gid}`
    } catch {
      // ignore
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined
    const who = uid !== undefined && gid !== undefined ? `${uid}:${gid}` : "current user"
    throw new Error(
      [
        `[metrics] cannot write metrics.db under ${HOME_DIR}`,
        `- dir owner: ${owner}`,
        `- process uid:gid: ${who}`,
        "",
        "Fix:",
        "- If running locally: `sudo chown -R $(id -u):$(id -g) home`",
        "- If running via docker-compose: set `AGENT_UID`/`AGENT_GID` in .env to match `id -u`/`id -g`, then recreate the container",
        "",
        `Original error: ${err?.message ?? String(err)}`,
      ].join("\n"),
    )
  }

  db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.exec(`
    create table if not exists metrics (
      id        integer primary key autoincrement,
      type      text not null,
      payload   text not null,
      createdAt text not null
    );
    create index if not exists idx_metrics_type on metrics(type);
    create index if not exists idx_metrics_created on metrics(createdAt desc);
    create index if not exists idx_metrics_type_id on metrics(type, id desc);
  `)
  console.log("[metrics] ready")
}

export function recordMetric(event: MetricEventInput): number | null {
  const timestamp = new Date().toISOString()
  
  if (db) {
    try {
      const stmt = db.prepare("insert into metrics (type, payload, createdAt) values (?, ?, ?)")
      const result = stmt.run(event.type, JSON.stringify(event), timestamp)
      
      const fullEvent = { ...event, timestamp, id: Number(result.lastInsertRowid) } as MetricEvent & { id: number }
      events.push(fullEvent)
      if (events.length > MAX_IN_MEMORY) {
        events.shift()
      }
      return fullEvent.id
    } catch (err) {
      console.error("[metrics] failed to record to db:", err)
    }
  }
  return null
}

const DEFAULT_METRIC_LIMIT = 100
const MAX_METRIC_LIMIT = 200
const DEFAULT_LIST_TYPES: MetricListType[] = ["memory", "summarization", "prompt_response", "prompt", "usage", "discord"]
const METRIC_TYPE_TO_SOURCE: Partial<Record<MetricListType, MetricEvent["type"]>> = {
  prompt_response: "prompt_response",
  summarization: "compaction",
  memory: "memory",
  prompt: "prompt",
  usage: "usage",
}
const METRIC_TYPE_TO_BUCKET: Record<MetricListType, MetricBucketName> = {
  memory: "memories",
  summarization: "summarization",
  prompt_response: "prompt_response",
  prompt: "prompt",
  usage: "usage",
  discord: "discord",
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) return DEFAULT_METRIC_LIMIT
  return Math.max(1, Math.min(MAX_METRIC_LIMIT, Math.floor(limit)))
}

function normalizeListTypes(type: MetricListType[] | undefined, includeRaw: boolean): MetricListType[] {
  const allowed = new Set<MetricListType>(DEFAULT_LIST_TYPES)
  if (!type || type.length === 0) return [...DEFAULT_LIST_TYPES]

  const normalized: MetricListType[] = []
  for (const item of type) {
    if (!allowed.has(item)) continue
    if (!normalized.includes(item)) normalized.push(item)
  }
  return normalized.length ? normalized : [...DEFAULT_LIST_TYPES]
}

function preview(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined

  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    return typeof record.text === "string" ? [record.text] : []
  })
  return parts.length ? parts.join("\n") : undefined
}

function lastUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (message?.role !== "user") continue
    const text = messageText(message.content)
    if (text) return preview(text)
  }
  return undefined
}

function parseMetricRow(row: MetricRow): MetricListItem | null {
  const payload = JSON.parse(row.payload) as Partial<MetricEvent> & Record<string, unknown>
  const base: BaseMetricListItem = {
    id: row.id,
    sourceType: row.type as MetricEvent["type"],
    timestamp: row.createdAt,
    detailPath: `/metrics/${row.id}`,
  }

  if (row.type === "prompt_response") {
    const response = payload.response as OpenAI.Chat.ChatCompletionMessage | undefined
    return {
      ...base,
      type: "prompt_response",
      promptMetricId: typeof payload.promptMetricId === "number" ? payload.promptMetricId : undefined,
      model: typeof payload.model === "string" ? payload.model : undefined,
      toolChoice: typeof payload.toolChoice === "string" ? payload.toolChoice : undefined,
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : undefined,
      lastUserMessage: lastUserMessage(payload.messages),
      responsePreview: preview(messageText(response?.content)),
      toolCallCount: Array.isArray(response?.tool_calls) ? response.tool_calls.length : undefined,
      usage: payload.usage as OpenAI.Completions.CompletionUsage | undefined,
    }
  }

  if (row.type === "compaction") {
    const before = typeof payload.before === "number" ? payload.before : undefined
    const after = typeof payload.after === "number" ? payload.after : undefined
    const summary = typeof payload.summary === "string" ? payload.summary : undefined
    return {
      ...base,
      type: "summarization",
      method: typeof payload.method === "string" ? payload.method : undefined,
      before,
      after,
      savedTokens: typeof before === "number" && typeof after === "number" ? before - after : undefined,
      summaryPreview: preview(summary),
      summaryChars: summary?.length,
    }
  }

  if (row.type === "memory") {
    return {
      ...base,
      type: "memory",
      queryPreview: preview(payload.query),
      resultCount: Array.isArray(payload.results) ? payload.results.length : undefined,
    }
  }

  if (row.type === "prompt") {
    return {
      ...base,
      type: "prompt",
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : undefined,
      lastUserMessage: lastUserMessage(payload.messages),
    }
  }

  if (row.type === "usage") {
    return {
      ...base,
      type: "usage",
      usage: payload.usage as OpenAI.Completions.CompletionUsage | undefined,
    }
  }

  return null
}

function metricCursor(query: MetricsQuery, bucket: MetricBucketName): number | undefined {
  const raw = query.cursors?.[bucket] ?? query.cursor
  const value = typeof raw === "string" ? parseInt(raw, 10) : raw
  return Number.isFinite(value) ? Math.floor(value as number) : undefined
}

function queryMetricBucket(
  type: MetricListType,
  bucket: MetricBucketName,
  query: MetricsQuery,
  limit: number,
): { items: MetricListItem[]; nextCursor?: number; hasMore: boolean } {
  const sourceType = METRIC_TYPE_TO_SOURCE[type]
  if (!sourceType || !db) return { items: [], hasMore: false }

  try {
    const where = ["type = ?"]
    const params: Array<string | number> = [sourceType]
    const cursor = metricCursor(query, bucket)

    if (cursor) {
      where.push("id < ?")
      params.push(cursor)
    }
    if (query.from) {
      where.push("createdAt >= ?")
      params.push(query.from)
    }
    if (query.to) {
      where.push("createdAt <= ?")
      params.push(query.to)
    }
    if (query.q?.trim()) {
      where.push("payload like ?")
      params.push(`%${query.q.trim()}%`)
    }

    const rows = db
      .prepare(
        `select id, type, payload, createdAt
         from metrics
         where ${where.join(" and ")}
         order by id desc
         limit ?`,
      )
      .all(...params, limit + 1) as MetricRow[]
    const pageRows = rows.slice(0, limit)
    const items = pageRows.flatMap((row) => {
      const item = parseMetricRow(row)
      return item ? [item] : []
    })
    const last = pageRows[pageRows.length - 1]
    return {
      items,
      nextCursor: rows.length > limit && last ? last.id : undefined,
      hasMore: rows.length > limit,
    }
  } catch (err) {
    console.error(`[metrics] failed to fetch ${type} bucket:`, err)
    return { items: [], hasMore: false }
  }
}

type DiscordMessageMetricRow = {
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
}

function queryDiscordBucket(
  query: MetricsQuery,
  limit: number,
): { items: DiscordMetricListItem[]; nextCursor?: string; hasMore: boolean } {
  try {
    const niriDb = getDb()
    const where: string[] = []
    const params: Array<string | number> = []
    const cursor = query.cursors?.discord

    if (typeof cursor === "string" && cursor.trim()) {
      where.push("created_at < ?")
      params.push(cursor)
    }
    if (query.from) {
      where.push("created_at >= ?")
      params.push(query.from)
    }
    if (query.to) {
      where.push("created_at <= ?")
      params.push(query.to)
    }
    if (query.q?.trim()) {
      where.push("(content like ? or author_username like ? or channel_id like ?)")
      const like = `%${query.q.trim()}%`
      params.push(like, like, like)
    }

    const rows = niriDb
      .prepare(
        `select message_id, channel_id, guild_id, author_id, author_username, content,
                created_at, is_dm, mentions_bot, is_from_bot
         from discord_messages
         ${where.length ? `where ${where.join(" and ")}` : ""}
         order by created_at desc
         limit ?`,
      )
      .all(...params, limit + 1) as DiscordMessageMetricRow[]
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => ({
      id: row.message_id,
      type: "discord" as const,
      sourceType: "discord" as const,
      timestamp: row.created_at,
      detailPath: `/metrics/discord/${row.message_id}`,
      messageId: row.message_id,
      channelId: row.channel_id,
      ...(row.guild_id ? { guildId: row.guild_id } : {}),
      ...(row.author_id ? { authorId: row.author_id } : {}),
      ...(row.author_username ? { authorUsername: row.author_username } : {}),
      contentPreview: preview(row.content),
      isDm: row.is_dm === 1,
      mentionsBot: row.mentions_bot === 1,
      isFromBot: row.is_from_bot === 1,
    }))
    const last = pageRows[pageRows.length - 1]
    return {
      items,
      nextCursor: rows.length > limit && last ? last.created_at : undefined,
      hasMore: rows.length > limit,
    }
  } catch (err) {
    if (err instanceof Error && err.message === "Database not initialized") return { items: [], hasMore: false }
    console.error("[metrics] failed to fetch discord bucket:", err)
    return { items: [], hasMore: false }
  }
}

export function getMetrics(query: MetricsQuery = {}): MetricsPage {
  const limit = clampLimit(query.limit)
  const includeRaw = query.includeRaw === true
  const types = normalizeListTypes(query.type, includeRaw)
  const selectedBuckets = new Set(types.map((type) => METRIC_TYPE_TO_BUCKET[type]))
  const nextCursor: Partial<Record<MetricBucketName, string | number>> = {}
  const hasMore: Partial<Record<MetricBucketName, boolean>> = {}
  const emptyMetricBucket: MetricListItem[] = []

  const readMetricBucket = (type: MetricListType): MetricListItem[] => {
    const bucket = METRIC_TYPE_TO_BUCKET[type]
    if (!selectedBuckets.has(bucket)) return emptyMetricBucket
    const result = queryMetricBucket(type, bucket, query, limit)
    if (result.nextCursor != null) nextCursor[bucket] = result.nextCursor
    hasMore[bucket] = result.hasMore
    return result.items
  }

  const readDiscordBucket = (): DiscordMetricListItem[] => {
    if (!selectedBuckets.has("discord")) return []
    const result = queryDiscordBucket(query, limit)
    if (result.nextCursor != null) nextCursor.discord = result.nextCursor
    hasMore.discord = result.hasMore
    return result.items
  }

  return {
    memories: readMetricBucket("memory"),
    summarization: readMetricBucket("summarization"),
    prompt_response: readMetricBucket("prompt_response"),
    prompt: readMetricBucket("prompt"),
    usage: readMetricBucket("usage"),
    discord: readDiscordBucket(),
    limit,
    nextCursor,
    hasMore,
    filters: {
      type: types,
      includeRaw,
      q: query.q,
      from: query.from,
      to: query.to,
    },
  }
}

export function getMetricDetail(id: number): (MetricEvent & { id: number }) | null {
  if (db) {
    try {
      const row = db.prepare("select id, type, payload, createdAt from metrics where id = ?").get(id) as MetricRow | undefined
      if (row) {
        const payload = JSON.parse(row.payload)
        return { ...payload, id: row.id, timestamp: row.createdAt }
      }
    } catch (err) {
      console.error("[metrics] failed to fetch detail from db:", err)
    }
  }
  return null
}

export function getDiscordMetricDetail(id: string): (DiscordMetricListItem & { raw: unknown }) | null {
  try {
    const row = getDb()
      .prepare(
        `select message_id, channel_id, guild_id, author_id, author_username, content,
                created_at, is_dm, mentions_bot, is_from_bot, raw_json
         from discord_messages
         where message_id = ?`,
      )
      .get(id) as (DiscordMessageMetricRow & { raw_json: string }) | undefined
    if (!row) return null

    let raw: unknown = null
    try {
      raw = JSON.parse(row.raw_json)
    } catch {
      raw = row.raw_json
    }

    return {
      id: row.message_id,
      type: "discord",
      sourceType: "discord",
      timestamp: row.created_at,
      detailPath: `/metrics/discord/${row.message_id}`,
      messageId: row.message_id,
      channelId: row.channel_id,
      ...(row.guild_id ? { guildId: row.guild_id } : {}),
      ...(row.author_id ? { authorId: row.author_id } : {}),
      ...(row.author_username ? { authorUsername: row.author_username } : {}),
      contentPreview: preview(row.content),
      isDm: row.is_dm === 1,
      mentionsBot: row.mentions_bot === 1,
      isFromBot: row.is_from_bot === 1,
      raw,
    }
  } catch (err) {
    if (err instanceof Error && err.message === "Database not initialized") return null
    console.error("[metrics] failed to fetch discord detail:", err)
    return null
  }
}
