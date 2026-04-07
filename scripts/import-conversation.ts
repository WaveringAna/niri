import Database from "better-sqlite3"
import { readFileSync } from "fs"
import path from "path"

const DB_PATH = path.resolve(import.meta.dirname, "../home/niri.db")
const JSONL_PATH = path.resolve(import.meta.dirname, "../first-conversation.jsonl")

const db = new Database(DB_PATH)

// Create conversation entry
const convId = db
  .prepare("insert into conversations (startedAt, source, tokens) values (?, ?, 0)")
  .run("2026-03-29T07:47:55.610Z", "birth")
  .lastInsertRowid as number

const insertMsg = db.prepare(
  "insert into messages (convId, role, content, createdAt) values (?, ?, ?, ?)",
)

const lines = readFileSync(JSONL_PATH, "utf-8").split("\n").filter(Boolean)

let count = 0

for (const line of lines) {
  const entry = JSON.parse(line)
  if (entry.type !== "message") continue

  const msg = entry.message
  const ts = entry.timestamp ?? new Date().toISOString()

  // We only want user and assistant text messages (no tool calls, tool results, thinking)
  if (msg.role === "user") {
    const text = extractText(msg.content)
    if (text) {
      insertMsg.run(convId, "user", text, ts)
      count++
    }
  } else if (msg.role === "assistant" && msg.content) {
    const parts = Array.isArray(msg.content) ? msg.content : []
    const texts = parts
      .filter((p: Record<string, unknown>) => p.type === "text")
      .map((p: Record<string, unknown>) => p.text as string)
    if (texts.length > 0) {
      insertMsg.run(convId, "assistant", texts.join("\n\n"), ts)
      count++
    }
  }
}

// Update with approximate token count from the session
db.prepare("update conversations set tokens = ? where id = ?").run(count * 100, convId)

console.log(`imported ${count} messages into conversation ${convId} (source: birth)`)

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p: Record<string, unknown>) => p.type === "text")
      .map((p: Record<string, unknown>) => p.text as string)
      .join("\n")
  }
  return ""
}
