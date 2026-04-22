import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { fileURLToPath } from "url"
import type { Message } from "./types.js"
import { getDb } from "./db.js"

const HOME_DIR = path.resolve(fileURLToPath(import.meta.url), "../../home")
const MEMORIES_DIR = path.join(HOME_DIR, "memories")
const JOURNAL_DIR = path.join(MEMORIES_DIR, "journal")
const PEOPLE_DIR = path.join(MEMORIES_DIR, "people")
const CORE_FILE = path.join(MEMORIES_DIR, "core.md")

const MEMORY_RECALL_HEADER = "[memory recall v1]"
const MEMORY_RECALL_NOTE =
  "Potentially relevant long-term notes. Use only if helpful; trust newer conversation details if anything conflicts."
const MEMORY_RECALL_MAX_CHUNKS = 3
const MEMORY_RECALL_MAX_CHARS = 1_100
const MEMORY_QUERY_TOKEN_LIMIT = 8
const MEMORY_RECALL_COOLDOWN_TURNS = 7
const MEMORY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your",
])

type MemoryKind = "core" | "journal" | "people"

type MemoryDocumentRow = {
  id: number
  path: string
  content_hash: string
  mtime_ms: number
  kind?: string
  title?: string
}

type MemoryChunkInput = {
  title: string
  headingPath: string | null
  text: string
  tags: string
}

type MemoryHit = {
  chunkId: number
  path: string
  kind: MemoryKind
  documentTitle: string
  title: string
  headingPath: string | null
  text: string
  rank: number
}

export type MemorySearchResult = {
  chunkId: number
  kind: MemoryKind
  path: string
  source: string
  title: string
  headingPath: string | null
  preview: string
}

type MemorySearchProfile = {
  normalized: string
  tokens: string[]
  personQuery: boolean
  eventQuery: boolean
}

type MemoryHitSignal = {
  overlap: number
  strongOverlap: boolean
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
}

function trimForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function basenameWithoutExt(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

function titleFromPath(filePath: string, fallback: string): string {
  const base = basenameWithoutExt(filePath).replace(/[-_]+/g, " ").trim()
  return base ? base : fallback
}

function detectMemoryKind(filePath: string): MemoryKind | null {
  if (filePath === CORE_FILE) return "core"
  if (filePath.startsWith(`${JOURNAL_DIR}${path.sep}`)) return "journal"
  if (filePath.startsWith(`${PEOPLE_DIR}${path.sep}`)) return "people"
  return null
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []

  const found: string[] = []
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walkMarkdownFiles(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(fullPath)
  }

  return found.sort()
}

async function listMemoryFiles(): Promise<string[]> {
  const files: string[] = []
  if (await pathExists(CORE_FILE)) files.push(CORE_FILE)
  files.push(...(await walkMarkdownFiles(JOURNAL_DIR)))
  files.push(...(await walkMarkdownFiles(PEOPLE_DIR)))
  return files
}

function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex")
}

function chunkLargeSection(text: string, maxChars = 900): string[] {
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

function parseMarkdownDocument(filePath: string, content: string): { title: string; chunks: MemoryChunkInput[] } {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const h1 = lines.find((line) => /^#\s+/.test(line))
  const title = h1 ? h1.replace(/^#\s+/, "").trim() : titleFromPath(filePath, "Memory")
  const headingStack: string[] = []
  let sectionLines: string[] = []
  let sectionTitle = title
  const chunks: MemoryChunkInput[] = []

  const flushSection = () => {
    const body = sectionLines.join("\n").trim()
    if (!body) {
      sectionLines = []
      return
    }

    const headingPath = headingStack.length > 0 ? headingStack.join(" > ") : null
    const tags = [basenameWithoutExt(filePath), ...headingStack].join(" ").trim()
    for (const part of chunkLargeSection(body)) {
      chunks.push({
        title: sectionTitle || title,
        headingPath,
        text: part,
        tags,
      })
    }
    sectionLines = []
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (!headingMatch) {
      sectionLines.push(line)
      continue
    }

    flushSection()

    const level = headingMatch[1]!.length
    const heading = headingMatch[2]!.trim()
    if (level === 1) {
      sectionTitle = heading || title
      headingStack.length = 0
      continue
    }

    while (headingStack.length >= level - 1) headingStack.pop()
    headingStack.push(heading)
    sectionTitle = heading || title
  }

  flushSection()

  if (chunks.length === 0) {
    const body = content.trim()
    if (body) {
      chunks.push({
        title,
        headingPath: null,
        text: body,
        tags: basenameWithoutExt(filePath),
      })
    }
  }

  return { title, chunks }
}

function memoryRecallCooldownTurns(kind: MemoryKind): number {
  if (kind === "people" || kind === "journal") return MEMORY_RECALL_COOLDOWN_TURNS
  return 0
}

function isCoolingDown(hit: MemoryHit, cooldowns: Record<number, number>, currentTurn: number): boolean {
  const lastTurn = cooldowns[hit.chunkId]
  if (typeof lastTurn !== "number") return false
  return currentTurn - lastTurn < memoryRecallCooldownTurns(hit.kind)
}

function latestUserMessage(conversation: Message[]): string | null {
  const last = conversation[conversation.length - 1]
  if (!last || last.role !== "user") return null
  if (typeof last.content !== "string") return null
  if (last.content.startsWith(MEMORY_RECALL_HEADER)) return null
  if (last.content.startsWith("[system]")) return null
  if (
    last.content.includes("[discord batch]") ||
    last.content.includes("scan snapshot:") ||
    last.content.includes("recent messages:") ||
    last.content.includes("pending preview:")
  ) {
    return null
  }
  return last.content
}

function normalizeSearchInput(raw: string): string {
  const withoutWakeEnvelope = raw.replace(/^\[(wake|incoming|harness restarted)[^\n]*\]\s*/gi, "").trim()

  const blocks = withoutWakeEnvelope
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)

  const bodyCandidate = blocks.length > 0 ? blocks[blocks.length - 1]! : withoutWakeEnvelope

  return bodyCandidate
    .replace(/^\[discord\/[^\]]+\]\s*@\S+\s+in\s+\d+(?:\s+\(\d+\))?\s*/gi, "")
    .replace(/^\[[^\]]+\]\s*/g, "")
    .replace(/@[a-z0-9_.-]+/gi, " ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .toLowerCase()
    .trim()
}

function searchTokens(raw: string): string[] {
  const clean = normalizeSearchInput(raw)

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

function buildSearchProfile(raw: string): MemorySearchProfile {
  const normalized = normalizeSearchInput(raw)
  const tokens = searchTokens(raw)

  return {
    normalized,
    tokens,
    personQuery:
      /\b(who is|who's|tell me about|about)\b/.test(normalized) ||
      /\bname\b/.test(normalized) ||
      /\bfriend\b/.test(normalized),
    eventQuery:
      /\b(what happened|when|yesterday|today|tonight|earlier|before|after|restart|restarted|session|wake)\b/.test(
        normalized,
      ) ||
      /\b\d{4}-\d{2}-\d{2}\b/.test(normalized) ||
      /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized) ||
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
        normalized,
      ),
  }
}

function buildSearchQuery(profile: MemorySearchProfile): string | null {
  if (profile.tokens.length === 0) return null
  return profile.tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ")
}

async function readMemoryDocumentRows(): Promise<Map<string, MemoryDocumentRow>> {
  const rows = getDb()
    .prepare("select id, path, kind, title, content_hash, mtime_ms from memory_documents")
    .all() as MemoryDocumentRow[]

  return new Map(rows.map((row) => [row.path, row]))
}

export async function syncMemoryIndex(): Promise<void> {
  const db = getDb()
  const files = await listMemoryFiles()
  const known = await readMemoryDocumentRows()
  const present = new Set(files)

  const deleteChunksByDocument = db.prepare("delete from memory_chunks where document_id = ?")
  const insertDocument = db.prepare(`
    insert into memory_documents (path, kind, title, mtime_ms, content_hash, updated_at)
    values (@path, @kind, @title, @mtime_ms, @content_hash, datetime('now'))
    on conflict(path) do update set
      kind = excluded.kind,
      title = excluded.title,
      mtime_ms = excluded.mtime_ms,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
  `)
  const selectDocumentId = db.prepare("select id from memory_documents where path = ?")
  const insertChunk = db.prepare(`
    insert into memory_chunks (document_id, chunk_index, title, heading_path, chunk_text, tags)
    values (?, ?, ?, ?, ?, ?)
  `)
  const deleteDocumentByPath = db.prepare("delete from memory_documents where path = ?")

  const updates: Array<{
    path: string
    kind: MemoryKind
    title: string
    mtimeMs: number
    hash: string
    chunks: MemoryChunkInput[]
    action: "inserted" | "updated"
  }> = []

  for (const filePath of files) {
    const kind = detectMemoryKind(filePath)
    if (!kind) continue

    const [content, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)])
    const hash = contentHash(content)
    const previous = known.get(filePath)
    if (previous && previous.content_hash === hash && previous.mtime_ms === Math.floor(stat.mtimeMs)) continue

    const parsed = parseMarkdownDocument(filePath, content)
    updates.push({
      path: filePath,
      kind,
      title: parsed.title,
      mtimeMs: Math.floor(stat.mtimeMs),
      hash,
      chunks: parsed.chunks,
      action: previous ? "updated" : "inserted",
    })
  }

  const removedPaths: string[] = []

  db.transaction(() => {
    for (const item of updates) {
      insertDocument.run({
        path: item.path,
        kind: item.kind,
        title: item.title,
        mtime_ms: item.mtimeMs,
        content_hash: item.hash,
      })
      const row = selectDocumentId.get(item.path) as { id: number } | undefined
      if (!row) continue

      deleteChunksByDocument.run(row.id)
      item.chunks.forEach((chunk, index) => {
        insertChunk.run(row.id, index, chunk.title, chunk.headingPath, chunk.text, chunk.tags)
      })

      console.log(
        `[memory] ${item.action} kind=${item.kind} chunks=${item.chunks.length} path=${path.relative(HOME_DIR, item.path)}`,
      )
    }

    for (const filePath of known.keys()) {
      if (present.has(filePath)) continue
      deleteDocumentByPath.run(filePath)
      removedPaths.push(filePath)
      console.log(`[memory] removed path=${path.relative(HOME_DIR, filePath)}`)
    }
  })()

  if (updates.length === 0 && removedPaths.length === 0) {
    return
  }
}

function scoreMemoryHit(hit: MemoryHit, profile: MemorySearchProfile): number {
  let score = hit.rank

  if (profile.personQuery && !profile.eventQuery) {
    if (hit.kind === "people") score -= 2
    if (hit.kind === "core") score -= 0.5
    if (hit.kind === "journal") score += 1.5
  } else if (profile.eventQuery && !profile.personQuery) {
    if (hit.kind === "journal") score -= 1.5
    if (hit.kind === "people") score += 0.75
    if (hit.kind === "core") score += 0.25
  } else {
    if (hit.kind === "people") score -= 0.5
    if (hit.kind === "core") score -= 0.25
  }

  const titleHaystack = `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)}`.toLowerCase()
  if (profile.tokens.some((token) => titleHaystack.includes(token))) score -= 0.35

  return score
}

function hitSearchHaystack(hit: MemoryHit): string {
  return `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)} ${hit.text}`.toLowerCase()
}

function memoryHitSignal(hit: MemoryHit, profile: MemorySearchProfile): MemoryHitSignal {
  const haystack = hitSearchHaystack(hit)
  let overlap = 0
  let strongOverlap = false

  for (const token of profile.tokens) {
    if (!haystack.includes(token)) continue
    overlap += 1
    if (token.length >= 5 || /[0-9]/.test(token)) strongOverlap = true
  }

  return { overlap, strongOverlap }
}

function shouldInjectHits(hits: MemoryHit[], profile: MemorySearchProfile): boolean {
  if (hits.length === 0) return false

  const topSignal = memoryHitSignal(hits[0]!, profile)

  if (profile.personQuery && !profile.eventQuery) {
    return topSignal.overlap >= 1 && hits.some((hit) => hit.kind === "people" || hit.kind === "core")
  }

  if (profile.eventQuery && !profile.personQuery) {
    return topSignal.overlap >= 1 && hits.some((hit) => hit.kind === "journal")
  }

  if (topSignal.overlap >= 2) return true
  if (topSignal.overlap >= 1 && topSignal.strongOverlap) return true
  return false
}

function searchMemory(
  profile: MemorySearchProfile,
  cooldowns: Record<number, number>,
  currentTurn: number,
  limit: number,
): MemoryHit[] {
  const db = getDb()
  const query = buildSearchQuery(profile)
  if (!query) return []
  const rows = db
    .prepare(`
      select
        c.id as chunkId,
        d.path as path,
        d.kind as kind,
        d.title as documentTitle,
        c.title as title,
        c.heading_path as headingPath,
        c.chunk_text as text,
        bm25(memory_chunks_fts, 5.0, 2.0, 1.0, 0.5) as rank
      from memory_chunks_fts
      join memory_chunks c on c.id = memory_chunks_fts.rowid
      join memory_documents d on d.id = c.document_id
      where memory_chunks_fts match ?
      order by rank
      limit ?
    `)
    .all(query, Math.max(limit * 8, limit)) as MemoryHit[]

  const ordered = rows.sort((a, b) => scoreMemoryHit(a, profile) - scoreMemoryHit(b, profile))
  const pool =
    profile.personQuery && !profile.eventQuery
      ? (() => {
          const structured = ordered.filter((row) => row.kind === "people" || row.kind === "core")
          return structured.length > 0 ? structured : ordered
        })()
      : profile.eventQuery && !profile.personQuery
        ? (() => {
            const journal = ordered.filter((row) => row.kind === "journal")
            return journal.length > 0 ? journal : ordered
          })()
        : ordered

  const deduped: MemoryHit[] = []
  const seenChunkIds = new Set<number>()
  for (const row of pool) {
    if (seenChunkIds.has(row.chunkId)) continue
    if (isCoolingDown(row, cooldowns, currentTurn)) continue
    seenChunkIds.add(row.chunkId)
    deduped.push(row)
    if (deduped.length >= limit) break
  }

  return deduped
}

function formatMemorySource(hit: MemoryHit): string {
  const relativePath = path.relative(HOME_DIR, hit.path)
  const pieces = [`[${hit.kind}]`, hit.documentTitle]
  if (hit.headingPath && hit.headingPath !== hit.documentTitle) pieces.push(hit.headingPath)
  pieces.push(relativePath)
  return pieces.join(" / ")
}

function toMemorySearchResult(hit: MemoryHit): MemorySearchResult {
  return {
    chunkId: hit.chunkId,
    kind: hit.kind,
    path: hit.path,
    source: formatMemorySource(hit),
    title: hit.title,
    headingPath: hit.headingPath,
    preview: trimForPrompt(normalizeText(hit.text), 280),
  }
}

function buildMemoryRecallMessage(hits: MemoryHit[]): string {
  const lines = [MEMORY_RECALL_HEADER, MEMORY_RECALL_NOTE, ""]
  let usedChars = lines.join("\n").length

  for (const hit of hits) {
    const source = formatMemorySource(hit)
    const remaining = Math.max(120, MEMORY_RECALL_MAX_CHARS - usedChars - source.length - 10)
    const body = trimForPrompt(normalizeText(hit.text), Math.min(280, remaining))
    const block = `- ${source}\n  ${body}`

    if (usedChars + block.length > MEMORY_RECALL_MAX_CHARS && lines.length > 3) break
    lines.push(block)
    usedChars += block.length + 1
  }

  return lines.join("\n").trim()
}

export async function buildCompletionMessages(
  conversation: Message[],
  cooldowns: Record<number, number>,
  currentTurn: number,
): Promise<{ messages: Message[]; recalledChunkIds: number[] }> {
  const latestUser = latestUserMessage(conversation)
  if (!latestUser) return { messages: conversation, recalledChunkIds: [] }

  await syncMemoryIndex()

  const profile = buildSearchProfile(latestUser)
  if (profile.tokens.length === 0) return { messages: conversation, recalledChunkIds: [] }

  const hits = searchMemory(profile, cooldowns, currentTurn, MEMORY_RECALL_MAX_CHUNKS)
  if (hits.length === 0) return { messages: conversation, recalledChunkIds: [] }
  if (!shouldInjectHits(hits, profile)) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(latestUser), 120))} personQuery=${profile.personQuery} eventQuery=${profile.eventQuery} reason=weak-match`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const recallContent = buildMemoryRecallMessage(hits)
  console.log(
    `[memory] recalled query=${JSON.stringify(trimForPrompt(normalizeText(latestUser), 120))} personQuery=${profile.personQuery} eventQuery=${profile.eventQuery}\n${recallContent}`,
  )

  const recallMessage: Message = {
    role: "user",
    content: recallContent,
  }

  return {
    messages: [...conversation, recallMessage],
    recalledChunkIds: hits.map((hit) => hit.chunkId),
  }
}

export function rememberRecalledMemoryChunks(
  cooldowns: Record<number, number>,
  injectedChunkIds: number[],
  currentTurn: number,
): Record<number, number> {
  const next = { ...cooldowns }
  for (const chunkId of injectedChunkIds) next[chunkId] = currentTurn

  for (const [chunkId, turn] of Object.entries(next)) {
    if (currentTurn - turn >= MEMORY_RECALL_COOLDOWN_TURNS * 2) delete next[Number(chunkId)]
  }

  return next
}

export async function searchMemories(rawQuery: string, limit = 5): Promise<MemorySearchResult[]> {
  await syncMemoryIndex()

  const profile = buildSearchProfile(rawQuery)
  if (profile.tokens.length === 0) return []

  return searchMemory(profile, {}, Number.POSITIVE_INFINITY, Math.max(1, Math.min(limit, 10))).map(toMemorySearchResult)
}
