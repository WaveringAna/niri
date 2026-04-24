import Database from "better-sqlite3"
import path from "path"
import { fileURLToPath } from "url"
import type OpenAI from "openai"
import type { Message } from "./types.js"
import type { MemorySearchResult } from "./memory.js"

export interface BaseMetricEvent {
  timestamp: string
}

export interface PromptMetric extends BaseMetricEvent {
  type: "prompt"
  messages: Message[]
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

export type MetricEvent = PromptMetric | MemoryMetric | CompactionMetric | UsageMetric

export interface MetricEventSummary extends BaseMetricEvent {
  id: number
  type: MetricEvent["type"]
  // Metadata for the feed
  messageCount?: number
  resultCount?: number
  method?: string
  before?: number
  after?: number
  usage?: OpenAI.Completions.CompletionUsage
}

export type MetricEventInput =
  | Omit<PromptMetric, "timestamp">
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
  `)
  console.log("[metrics] ready")
}

export function recordMetric(event: MetricEventInput): void {
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
    } catch (err) {
      console.error("[metrics] failed to record to db:", err)
    }
  }
}

export function getMetrics(limit = 100): MetricEventSummary[] {
  if (db) {
    try {
      const rows = db.prepare("select id, type, payload, createdAt from metrics order by createdAt desc limit ?").all(limit) as MetricRow[]
      return rows.map((row) => {
        const payload = JSON.parse(row.payload)
        const summary: MetricEventSummary = {
          id: row.id,
          type: row.type as any,
          timestamp: row.createdAt,
        }

        if (row.type === "prompt") {
          summary.messageCount = payload.messages?.length
        } else if (row.type === "memory") {
          summary.resultCount = payload.results?.length
        } else if (row.type === "compaction") {
          summary.method = payload.method
          summary.before = payload.before
          summary.after = payload.after
        } else if (row.type === "usage") {
          summary.usage = payload.usage
        }

        return summary
      })
    } catch (err) {
      console.error("[metrics] failed to fetch from db:", err)
    }
  }
  return []
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
