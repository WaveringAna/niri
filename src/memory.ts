import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { fileURLToPath } from "url"
import type { Message } from "./types.js"
import { getDb } from "./db.js"
import { recordMetric } from "./metrics.js"

const HOME_DIR = path.resolve(fileURLToPath(import.meta.url), "../../home")
const MEMORIES_DIR = path.join(HOME_DIR, "memories")
const JOURNAL_DIR = path.join(MEMORIES_DIR, "journal")
const PEOPLE_DIR = path.join(MEMORIES_DIR, "people")
const CORE_FILE = path.join(MEMORIES_DIR, "core.md")
const ALIASES_FILE = path.join(MEMORIES_DIR, "aliases.json")

const MEMORY_RECALL_HEADER = "[memory recall v1]"
const MEMORY_RECALL_NOTE =
  "Potentially relevant long-term notes. Use only if helpful; trust newer conversation details if anything conflicts."
const MEMORY_RECALL_MAX_CHUNKS = 4
const MEMORY_RECALL_MAX_CHUNKS_HARD_CAP = 8
const MEMORY_RECALL_MAX_CHARS = 1_500
const MEMORY_RECALL_PER_EXTRA_PERSON_CHARS = 400
const MEMORY_QUERY_TOKEN_LIMIT = 12
const MEMORY_RECALL_COOLDOWN_TURNS = 7
const SCHEDULED_HEARTBEAT_CONTENT = "Scheduled heartbeat."
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

type MemoryQueryParts = {
  sender: string | null
  source: string | null
  body: string
}

type MemorySearchProfile = {
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

type MemoryHitSignal = {
  overlap: number
  strongOverlap: boolean
  bodyOverlap: number
  senderMatch: boolean
}

export type AliasMap = Record<string, string[]>

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

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase()
}

let aliasCache: { mtimeMs: number; map: AliasMap } | null = null

async function loadAliasMap(): Promise<AliasMap> {
  try {
    const stat = await fs.stat(ALIASES_FILE)
    if (aliasCache && aliasCache.mtimeMs === stat.mtimeMs) return aliasCache.map
    const raw = await fs.readFile(ALIASES_FILE, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    const map: AliasMap = {}
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const handle = normalizeHandle(key)
        if (!handle) continue
        const list = Array.isArray(value) ? value : [value]
        const aliases = list
          .map((v) => (typeof v === "string" ? normalizeHandle(v) : ""))
          .filter((v) => v && v !== handle)
        if (aliases.length > 0) map[handle] = Array.from(new Set(aliases))
      }
    }
    aliasCache = { mtimeMs: stat.mtimeMs, map }
    return map
  } catch {
    aliasCache = { mtimeMs: 0, map: {} }
    return {}
  }
}

async function writeAliasMap(map: AliasMap): Promise<void> {
  await fs.mkdir(MEMORIES_DIR, { recursive: true })
  const sorted: AliasMap = {}
  for (const key of Object.keys(map).sort()) sorted[key] = [...map[key]!].sort()
  await fs.writeFile(ALIASES_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8")
  aliasCache = null
}

function resolveAliases(handle: string | null, map: AliasMap): string[] {
  if (!handle) return []
  const seen = new Set<string>([handle])
  const out: string[] = []
  const queue = [handle]
  while (queue.length > 0) {
    const current = queue.shift()!
    const next = map[current] ?? []
    for (const alias of next) {
      if (seen.has(alias)) continue
      seen.add(alias)
      out.push(alias)
      queue.push(alias)
    }
  }
  return out
}

export async function listAliases(): Promise<AliasMap> {
  return loadAliasMap()
}

export async function setAlias(handle: string, canonical: string): Promise<AliasMap> {
  const h = normalizeHandle(handle)
  const c = normalizeHandle(canonical)
  if (!h || !c) throw new Error("alias handle and canonical must be non-empty")
  const map = await loadAliasMap()
  if (h === c) return map
  const existing = new Set(map[h] ?? [])
  existing.add(c)
  map[h] = Array.from(existing)
  await writeAliasMap(map)
  return map
}

export async function removeAlias(handle: string, canonical?: string): Promise<AliasMap> {
  const h = normalizeHandle(handle)
  if (!h) throw new Error("alias handle must be non-empty")
  const map = await loadAliasMap()
  if (!map[h]) return map
  if (canonical) {
    const c = normalizeHandle(canonical)
    map[h] = map[h]!.filter((entry) => entry !== c)
    if (map[h]!.length === 0) delete map[h]
  } else {
    delete map[h]
  }
  await writeAliasMap(map)
  return map
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

function isMemoryRecallSkippedMessage(content: string): boolean {
  if (content.startsWith(MEMORY_RECALL_HEADER)) return true
  if (content.startsWith("[system]")) return true
  if (content.includes("scan snapshot:") && !content.includes("[discord batch]")) return true
  return false
}

function latestMemoryRecallQuery(conversation: Message[]): string | null {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i]
    if (!message || message.role !== "user") continue
    if (typeof message.content !== "string") continue

    const content = message.content.trim()
    if (!content || isMemoryRecallSkippedMessage(content)) continue
    if (content === SCHEDULED_HEARTBEAT_CONTENT) continue
    return content
  }
  return null
}

function discordChannelLabel(channelId: string | null, fallbackContext: string | null, isDm: boolean): string {
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

function conciseDiscordMemoryQuery(raw: string): MemoryQueryParts | null {
  const withoutWakeEnvelope = raw.replace(/^\[(wake|incoming|harness restarted)[^\n]*\]\s*/gi, "").trim()
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

function conciseDiscordBatchMemoryQuery(raw: string): MemoryQueryParts | null {
  const withoutWakeEnvelope = raw.replace(/^\[(wake|incoming|harness restarted)[^\n]*\]\s*/gi, "").trim()
  if (!/\[discord batch\]/i.test(withoutWakeEnvelope)) return null

  const recent = extractBulletSection(withoutWakeEnvelope, "recent messages")
  const pending = extractBulletSection(withoutWakeEnvelope, "pending preview")
  const selected = (recent.length > 0 ? recent : pending).slice(-3)
  if (selected.length === 0) return null

  const senders: string[] = []
  const sources: string[] = []
  const bodies: string[] = []
  const entryPattern = /^\[([^\]]+)\]\s+\[[^\]]+\]\s+@([^:]+):\s*(.*)$/i
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

function memoryQueryForUserMessage(raw: string): MemoryQueryParts {
  return (
    conciseDiscordMemoryQuery(raw) ??
    conciseDiscordBatchMemoryQuery(raw) ??
    { sender: null, source: null, body: raw }
  )
}

function memoryQueryToString(parts: MemoryQueryParts): string {
  const pieces = [
    parts.sender ? `@${parts.sender}` : null,
    parts.source,
    parts.body || null,
  ].filter((value): value is string => Boolean(value && value.trim()))
  return pieces.join("\n")
}

function normalizeBodyText(raw: string): string {
  return raw
    .replace(/@([a-z0-9_.-]+)/gi, " $1 ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .toLowerCase()
    .trim()
}

function tokensFromText(raw: string): string[] {
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

function searchTokens(raw: string): string[] {
  return tokensFromText(raw)
}

const BODY_INFORMATIVE_BM25_THRESHOLD = -5

function bestBodyBm25(bodyTokens: string[]): number | null {
  if (bodyTokens.length === 0) return null
  const query = bodyTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ")
  try {
    const row = getDb()
      .prepare(
        "select bm25(memory_chunks_fts, 5.0, 2.0, 1.0, 0.5) as r from memory_chunks_fts where memory_chunks_fts match ? order by r limit 1",
      )
      .get(query) as { r: number } | undefined
    return row?.r ?? null
  } catch {
    return null
  }
}

function computeBodyInformativeness(bodyTokens: string[], bodyPeople: string[]): boolean {
  if (bodyPeople.length > 0) return true
  if (bodyTokens.length === 0) return false
  const top = bestBodyBm25(bodyTokens)
  if (top === null) return false
  return top <= BODY_INFORMATIVE_BM25_THRESHOLD
}

async function knownPeopleHandles(aliasMap: AliasMap): Promise<Set<string>> {
  const handles = new Set<string>()
  if (await pathExists(PEOPLE_DIR)) {
    const entries = await fs.readdir(PEOPLE_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const base = basenameWithoutExt(entry.name).toLowerCase()
      if (base) handles.add(base)
    }
  }
  for (const [key, values] of Object.entries(aliasMap)) {
    handles.add(key)
    for (const value of values) handles.add(value)
  }
  return handles
}

async function buildSearchProfile(parts: MemoryQueryParts): Promise<MemorySearchProfile> {
  const aliasMap = await loadAliasMap()
  const sender = parts.sender ? normalizeHandle(parts.sender) : null
  const senderAliases = resolveAliases(sender, aliasMap)
  const bodyTokens = parts.body ? tokensFromText(parts.body) : []

  const known = await knownPeopleHandles(aliasMap)
  const inlineMentions = parts.body
    ? Array.from(parts.body.matchAll(/@([a-z0-9_.-]+)/gi)).map((match) => normalizeHandle(match[1]!))
    : []
  const bodyPeopleSet = new Set<string>()
  const senderSet = new Set<string>([sender ?? "", ...senderAliases].filter(Boolean))
  for (const token of [...bodyTokens, ...inlineMentions]) {
    if (!token || senderSet.has(token)) continue
    if (known.has(token)) bodyPeopleSet.add(token)
  }
  const bodyPeople = Array.from(bodyPeopleSet)
  for (const person of [...bodyPeople]) {
    for (const alias of resolveAliases(person, aliasMap)) {
      if (!senderSet.has(alias)) bodyPeopleSet.add(alias)
    }
  }
  const bodyPeopleResolved = Array.from(bodyPeopleSet)

  const combined: string[] = []
  const seen = new Set<string>()
  const push = (value: string | null | undefined) => {
    if (!value) return
    const lower = value.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    combined.push(lower)
  }
  push(sender)
  for (const alias of senderAliases) push(alias)
  for (const person of bodyPeopleResolved) push(person)
  for (const token of bodyTokens) push(token)

  const normalized = [sender ? `@${sender}` : "", parts.source ?? "", parts.body ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  const bodyInformative = computeBodyInformativeness(bodyTokens, bodyPeopleResolved)

  return {
    normalized,
    sender,
    senderAliases,
    bodyTokens,
    bodyPeople: bodyPeopleResolved,
    tokens: combined.slice(0, MEMORY_QUERY_TOKEN_LIMIT),
    bodyInformative,
    personQuery:
      Boolean(sender) ||
      bodyPeopleResolved.length > 0 ||
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

function senderHandles(profile: MemorySearchProfile): string[] {
  const out: string[] = []
  if (profile.sender) out.push(profile.sender)
  for (const alias of profile.senderAliases) out.push(alias)
  return out
}

function allPersonHandles(profile: MemorySearchProfile): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const handle of [...senderHandles(profile), ...profile.bodyPeople]) {
    if (!handle || seen.has(handle)) continue
    seen.add(handle)
    out.push(handle)
  }
  return out
}

function hitMatchesHandle(hit: MemoryHit, handle: string): boolean {
  const titleHaystack = `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)}`.toLowerCase()
  const pathHaystack = hit.path.toLowerCase()
  return titleHaystack.includes(handle) || pathHaystack.includes(`/${handle}.md`)
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
  if (profile.bodyTokens.some((token) => titleHaystack.includes(token))) score -= 0.35

  const handles = allPersonHandles(profile)
  if (handles.length > 0) {
    const fullHaystack = `${titleHaystack} ${hit.text.toLowerCase()}`
    const pathHaystack = hit.path.toLowerCase()
    if (handles.some((h) => titleHaystack.includes(h) || pathHaystack.includes(`/${h}.md`))) {
      score -= 3
    } else if (handles.some((h) => fullHaystack.includes(h))) {
      score -= 1
    }
  }

  return score
}

function hitSearchHaystack(hit: MemoryHit): string {
  return `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)} ${hit.text}`.toLowerCase()
}

function memoryHitSignal(hit: MemoryHit, profile: MemorySearchProfile): MemoryHitSignal {
  const haystack = hitSearchHaystack(hit)
  let overlap = 0
  let strongOverlap = false
  let bodyOverlap = 0

  for (const token of profile.tokens) {
    if (!haystack.includes(token)) continue
    overlap += 1
    if (token.length >= 5 || /[0-9]/.test(token)) strongOverlap = true
  }
  for (const token of profile.bodyTokens) {
    if (haystack.includes(token)) bodyOverlap += 1
  }

  const handles = allPersonHandles(profile)
  const titleHaystack = `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)}`.toLowerCase()
  const pathHaystack = hit.path.toLowerCase()
  const senderMatch =
    handles.length > 0 &&
    handles.some((h) => titleHaystack.includes(h) || pathHaystack.includes(`/${h}.md`) || haystack.includes(h))

  return { overlap, strongOverlap, bodyOverlap, senderMatch }
}

function shouldInjectHits(hits: MemoryHit[], profile: MemorySearchProfile): boolean {
  if (hits.length === 0) return false

  const topSignal = memoryHitSignal(hits[0]!, profile)

  if (profile.sender || profile.bodyPeople.length > 0) {
    if (!profile.bodyInformative) return false
    if (topSignal.senderMatch) return true
    if (topSignal.bodyOverlap >= 2) return true
    if (topSignal.bodyOverlap >= 1 && topSignal.strongOverlap) return true
    return false
  }

  if (profile.eventQuery && !profile.personQuery) {
    return topSignal.overlap >= 1 && hits.some((hit) => hit.kind === "journal")
  }

  if (profile.personQuery && !profile.eventQuery) {
    return topSignal.overlap >= 1 && hits.some((hit) => hit.kind === "people" || hit.kind === "core")
  }

  if (topSignal.bodyOverlap >= 2) return true
  if (topSignal.bodyOverlap >= 1 && topSignal.strongOverlap) return true
  if (topSignal.overlap >= 2 && topSignal.strongOverlap) return true
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
  const seenPaths = new Set<string>()

  const handles = allPersonHandles(profile)
  if (handles.length >= 2) {
    for (const handle of handles) {
      if (deduped.length >= limit) break
      const candidate = pool.find(
        (row) =>
          !seenChunkIds.has(row.chunkId) &&
          !seenPaths.has(row.path) &&
          !isCoolingDown(row, cooldowns, currentTurn) &&
          hitMatchesHandle(row, handle),
      )
      if (!candidate) continue
      seenChunkIds.add(candidate.chunkId)
      seenPaths.add(candidate.path)
      deduped.push(candidate)
    }
  }

  for (const row of pool) {
    if (deduped.length >= limit) break
    if (seenChunkIds.has(row.chunkId)) continue
    if (isCoolingDown(row, cooldowns, currentTurn)) continue
    seenChunkIds.add(row.chunkId)
    deduped.push(row)
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

function buildMemoryRecallMessage(hits: MemoryHit[], maxChars: number): string {
  const lines = [MEMORY_RECALL_HEADER, MEMORY_RECALL_NOTE, ""]
  let usedChars = lines.join("\n").length

  for (const hit of hits) {
    const source = formatMemorySource(hit)
    const remaining = Math.max(120, maxChars - usedChars - source.length - 10)
    const body = trimForPrompt(normalizeText(hit.text), Math.min(280, remaining))
    const block = `- ${source}\n  ${body}`

    if (usedChars + block.length > maxChars && lines.length > 3) break
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
  const memoryQuerySource = latestMemoryRecallQuery(conversation)
  if (!memoryQuerySource) return { messages: conversation, recalledChunkIds: [] }
  const queryParts = memoryQueryForUserMessage(memoryQuerySource)
  const memoryQuery = memoryQueryToString(queryParts)

  await syncMemoryIndex()

  const profile = await buildSearchProfile(queryParts)
  if (profile.tokens.length === 0) return { messages: conversation, recalledChunkIds: [] }

  if ((profile.sender || profile.bodyPeople.length > 0) && !profile.bodyInformative) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} sender=${profile.sender ?? "-"} reason=trivial-body`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const personCount = allPersonHandles(profile).length
  const recallLimit = Math.min(
    MEMORY_RECALL_MAX_CHUNKS_HARD_CAP,
    personCount >= 2 ? MEMORY_RECALL_MAX_CHUNKS + (personCount - 1) : MEMORY_RECALL_MAX_CHUNKS,
  )
  const hits = searchMemory(profile, cooldowns, currentTurn, recallLimit)
  const aliasInfo = profile.senderAliases.length > 0 ? ` aliases=${profile.senderAliases.join(",")}` : ""
  const peopleInfo = profile.bodyPeople.length > 0 ? ` people=${profile.bodyPeople.join(",")}` : ""
  const debugTag = `sender=${profile.sender ?? "-"}${aliasInfo}${peopleInfo} personQuery=${profile.personQuery} eventQuery=${profile.eventQuery}`
  if (hits.length === 0) {
    console.log(
      `[memory] no-hits query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag}`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }
  if (!shouldInjectHits(hits, profile)) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag} reason=weak-match`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const extraPersons = Math.max(0, personCount - 1)
  const recallChars = MEMORY_RECALL_MAX_CHARS + extraPersons * MEMORY_RECALL_PER_EXTRA_PERSON_CHARS
  const recallContent = buildMemoryRecallMessage(hits, recallChars)
  console.log(
    `[memory] recalled query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag}\n${recallContent}`,
  )

  recordMetric({
    type: "memory",
    query: memoryQuery,
    results: hits.map(toMemorySearchResult),
  })

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

export const __memoryTest = {
  latestMemoryRecallQuery,
  memoryQueryForUserMessage,
  memoryQueryToString,
  normalizeBodyText,
  searchTokens,
  buildSearchProfile,
  resolveAliases,
  normalizeHandle,
}

export async function searchMemories(rawQuery: string, limit = 5): Promise<MemorySearchResult[]> {
  await syncMemoryIndex()

  const profile = await buildSearchProfile({ sender: null, source: null, body: rawQuery })
  if (profile.tokens.length === 0) return []

  const results = searchMemory(profile, {}, Number.POSITIVE_INFINITY, Math.max(1, Math.min(limit, 10))).map(toMemorySearchResult)
  recordMetric({
    type: "memory",
    query: rawQuery,
    results,
  })
  return results
}
