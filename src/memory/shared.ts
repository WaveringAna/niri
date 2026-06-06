/**
 * Shared constants, types, and pure utility functions used across memory modules.
 *
 * @module memory/shared
 */

import fs from "fs/promises"
import path from "path"
import { HOME_DIR } from "../container/config"

// ── directory layout ───────────────────────────────────────────────────

export const MEMORIES_DIR = path.join(HOME_DIR, "memories")
export const JOURNAL_DIR = path.join(MEMORIES_DIR, "journal")
export const PEOPLE_DIR = path.join(MEMORIES_DIR, "people")
export const CORE_FILE = path.join(MEMORIES_DIR, "core.md")
export const ALIASES_FILE = path.join(MEMORIES_DIR, "aliases.json")

// ── tuning constants ───────────────────────────────────────────────────

export const MEMORY_RECALL_HEADER = "[injected recalled memories]"
export const MEMORY_RECALL_NOTE =
  "Potentially relevant long-term notes. Use only if helpful; trust newer conversation details if anything conflicts."
export const MEMORY_RECALL_MAX_CHUNKS = 4
export const MEMORY_RECALL_MAX_CHUNKS_HARD_CAP = 8
export const MEMORY_QUERY_TOKEN_LIMIT = 12
export const MEMORY_RECALL_COOLDOWN_TURNS = 7
export const MEMORY_EMBEDDING_BATCH_SIZE = 24
export const MEMORY_SEMANTIC_MIN_SIMILARITY = 0.18
export const MEMORY_SEMANTIC_STRONG_SIMILARITY = 0.32
export const MEMORY_CHATTER_SIMILARITY_THRESHOLD = 0.74
export const MEMORY_RECALL_INTENT_SIMILARITY_THRESHOLD = 0.55
export const SCHEDULED_HEARTBEAT_CONTENT = "Scheduled heartbeat."
export const BODY_INFORMATIVE_BM25_THRESHOLD = -5

export const MEMORY_EMBEDDING_PROTOTYPES = [
  { id: 1, name: "affection-love", category: "chatter", text: "i love you so much sweetie <33" },
  { id: 2, name: "cat-greeting", category: "chatter", text: "boop mraow meow hi sweetie" },
  { id: 3, name: "celebration", category: "chatter", text: "yay yayy lets gooooo <33" },
  { id: 4, name: "goodnight", category: "chatter", text: "goodnight sweet dreams rest well" },
  { id: 101, name: "who-person", category: "recall_intent", text: "who is this person what do i know about them" },
  { id: 102, name: "past-event", category: "recall_intent", text: "what happened before remember when that event happened" },
  { id: 103, name: "task-context", category: "recall_intent", text: "what context do i need for this task or project" },
  { id: 104, name: "system-lesson", category: "recall_intent", text: "what lesson or instruction should i remember here" },
] as const

export const MEMORY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "hers", "him",
  "his", "i", "if", "in", "into", "is", "it", "its", "me", "my",
  "of", "on", "or", "our", "she", "that", "the", "their", "them",
  "there", "they", "this", "to", "up", "us", "was", "we", "were",
  "with", "you", "your",
])

// ── types ──────────────────────────────────────────────────────────────

export type MemoryKind = "core" | "journal" | "people"

export type MemoryDocumentRow = {
  id: number
  path: string
  content_hash: string
  mtime_ms: number
  kind?: string
  title?: string
}

export type MemoryChunkInput = {
  title: string
  headingPath: string | null
  text: string
  tags: string
}

export type MemoryHit = {
  chunkId: number
  path: string
  kind: MemoryKind
  documentTitle: string
  title: string
  headingPath: string | null
  text: string
  rank: number
  semanticDistance?: number
  semanticSimilarity?: number
}

export type MemorySearchResult = {
  chunkId: number
  kind: MemoryKind
  path: string
  source: string
  title: string
  headingPath: string | null
  content: string
  preview: string
}

export type AliasMap = Record<string, string[]>

export type MemorySearchProfile = {
  normalized: string
  sender: string | null
  senderAliases: string[]
  bodyTokens: string[]
  bodyPeople: string[]
  tokens: string[]
  personQuery: boolean
  eventQuery: boolean
  bodyInformative: boolean
}

export type SemanticQuerySignal = {
  vector: number[]
  chatterSimilarity: number | null
  recallIntentSimilarity: number | null
}

// ── pure utilities ─────────────────────────────────────────────────────

/**
 * Normalizes line endings and collapses whitespace.
 *
 * @param value - Raw text.
 * @returns Cleaned text.
 */
export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
}

/**
 * Truncates text to a maximum character count, appending `...` when truncated.
 *
 * @param value - Text to trim.
 * @param maxChars - Maximum character count.
 * @returns Trimmed text.
 */
export function trimForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

/**
 * Returns the filename without extension.
 *
 * @param filePath - File path.
 * @returns Basename with extension removed.
 */
export function basenameWithoutExt(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

/**
 * Splits text into paragraph-delimited chunks that fit within a character budget.
 *
 * @param text - Text to chunk.
 * @param maxChars - Maximum characters per chunk.
 * @returns Array of text chunks.
 */
export function chunkLargeSection(text: string, maxChars = 900): string[] {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)

  if (paragraphs.length === 0) return []

  const chunks: string[] = []
  let current = ""

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= maxChars || current.length === 0) {
      current = next
      continue
    }
    chunks.push(current)
    current = paragraph
  }

  if (current) chunks.push(current)
  return chunks
}

/**
 * Derives a human-readable title from a file path.
 *
 * @param filePath - File path.
 * @param fallback - Fallback title when the path yields nothing.
 * @returns Title string.
 */
export function titleFromPath(filePath: string, fallback: string): string {
  const base = basenameWithoutExt(filePath).replace(/[-_]+/g, " ").trim()
  return base ? base : fallback
}

/**
 * Classifies a memory file by its path.
 *
 * @param filePath - Absolute file path.
 * @returns Memory kind, or `null` when the path is outside known directories.
 */
export function detectMemoryKind(filePath: string): MemoryKind | null {
  if (filePath === CORE_FILE) return "core"
  if (filePath.startsWith(`${JOURNAL_DIR}${path.sep}`)) return "journal"
  if (filePath.startsWith(`${PEOPLE_DIR}${path.sep}`)) return "people"
  return null
}

/**
 * Checks whether a filesystem path exists.
 *
 * @param target - Path to check.
 * @returns `true` when accessible.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Normalizes a user handle by trimming and removing leading `@` signs.
 *
 * @param handle - Raw handle string.
 * @returns Lowercased, cleaned handle.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase()
}

/**
 * Normalizes body text for tokenization — strips mentions, ids, punctuation.
 *
 * @param raw - Raw text.
 * @returns Lowercased, cleaned text.
 */
export function normalizeBodyText(raw: string): string {
  return raw
    .replace(/@([a-z0-9_.-]+)/gi, " $1 ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .toLowerCase()
    .trim()
}

/**
 * Tokenizes text into deduplicated search terms, stopping at the token limit.
 *
 * @param raw - Raw text to tokenize.
 * @returns Array of unique meaningful tokens.
 */
export function tokensFromText(raw: string): string[] {
  const clean = normalizeBodyText(raw)
  const tokens = clean
    .split(/\s+/)
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => token.length >= 2 || /\d{2,}/.test(token))
    .filter((token) => !MEMORY_STOP_WORDS.has(token))

  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    unique.push(token)
    if (unique.length >= MEMORY_QUERY_TOKEN_LIMIT) break
  }
  return unique
}
