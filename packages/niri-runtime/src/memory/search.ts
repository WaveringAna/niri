/**
 * Memory search — profile building, FTS query, scoring, dedup, and gating.
 *
 * The scoring pipeline is consolidated into two core functions:
 * - `scoreHit` computes a single numeric rank combining BM25, kind boosting,
 *   person matching, token overlap, and semantic similarity.
 * - `isRelevant` decides whether the top hit is strong enough to inject.
 *
 * @module memory/search
 */

import fs from "fs/promises"
import path from "path"
import { getDb, isVecAvailable, MEMORY_EMBEDDING_DIMENSIONS } from "../db"
import { EMBEDDING_DIMENSIONS, embeddingsConfigured, embedTexts } from "../embeddings"
import {
  basenameWithoutExt,
  BODY_INFORMATIVE_BM25_THRESHOLD,
  MEMORY_CHATTER_SIMILARITY_THRESHOLD,
  MEMORY_RECALL_COOLDOWN_TURNS,
  MEMORY_RECALL_INTENT_SIMILARITY_THRESHOLD,
  MEMORY_SEMANTIC_MIN_SIMILARITY,
  MEMORY_SEMANTIC_STRONG_SIMILARITY,
  MEMORY_QUERY_TOKEN_LIMIT,
  normalizeHandle,
  normalizeText,
  PEOPLE_DIR,
  tokensFromText,
  type MemoryHit,
  type MemorySearchProfile,
  type SemanticQuerySignal,
} from "./shared"
import { NIRI_HOME as HOME_DIR } from "../agent-config"
import { loadAliasMap, resolveAliases } from "./aliases"

// ── handle helpers ─────────────────────────────────────────────────────

/** All handles associated with the sender (sender + sender aliases). */
function senderHandles(profile: MemorySearchProfile): string[] {
  const out: string[] = []
  if (profile.sender) out.push(profile.sender)
  for (const alias of profile.senderAliases) out.push(alias)
  return out
}

/** All person handles: sender + aliases + body-mentioned people. */
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

/** Target person handles for exact matching — prefers body mentions over sender. */
function targetPersonHandles(profile: MemorySearchProfile): string[] {
  return profile.bodyPeople.length > 0 ? profile.bodyPeople : allPersonHandles(profile)
}

// ── haystack / matching ────────────────────────────────────────────────

/** Lowercase text blob of all searchable fields for a hit. */
function hitHaystack(hit: MemoryHit): string {
  return `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)} ${hit.text}`.toLowerCase()
}

/** Title + path only (lighter match for handle-in-filename detection). */
function hitTitlePath(hit: MemoryHit): string {
  return `${hit.documentTitle} ${hit.title} ${hit.headingPath ?? ""} ${basenameWithoutExt(hit.path)}`.toLowerCase()
}

/** Whether a handle appears in the hit's title/path/filename. */
function handleInTitlePath(hit: MemoryHit, handle: string): boolean {
  return hitTitlePath(hit).includes(handle) || hit.path.toLowerCase().includes(`/${handle}.md`)
}

// ── intent classification ──────────────────────────────────────────────

function profileHasExplicitRecallIntent(profile: MemorySearchProfile): boolean {
  if (profile.bodyPeople.length > 0) return true
  if (profile.eventQuery) return true
  return /\b(who is|who's|tell me about|remember|recall|what happened|what do i know|context)\b/.test(profile.normalized)
}

function profileHasCoreIntent(profile: MemorySearchProfile): boolean {
  return /\b(core|identity|system|environment|lesson|rule|instruction|workflow|tool|config|memory)\b/.test(profile.normalized)
}

// ── scoring ────────────────────────────────────────────────────────────

/**
 * Computes a single numeric score for a memory hit, combining:
 * - BM25 base rank
 * - kind-based boosting (people/journal/core)
 * - person handle matching (title/path bonus, text mention bonus, target person bonus)
 * - body token overlap with title
 * - semantic similarity (when available)
 *
 * Lower scores are better.
 *
 * @param hit - Candidate memory hit.
 * @param profile - Search profile with query signals.
 * @param semanticSimilarity - Optional semantic similarity score (0–1).
 * @returns Numeric score (lower = better match).
 */
function scoreHit(hit: MemoryHit, profile: MemorySearchProfile, semanticSimilarity?: number): number {
  let score = hit.rank
  const coreIntent = profileHasCoreIntent(profile)

  // ── kind-based boosting ──
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

  // ── body token title overlap ──
  const titleLower = hitTitlePath(hit)
  if (profile.bodyTokens.some((token) => titleLower.includes(token))) score -= 0.35

  // ── person handle matching ──
  const handles = allPersonHandles(profile)
  if (handles.length > 0) {
    const fullHaystack = hitHaystack(hit)
    const pathHaystack = hit.path.toLowerCase()

    // Strong bonus: handle in filename/title/path
    if (handles.some((h) => titleLower.includes(h) || pathHaystack.includes(`/${h}.md`))) {
      score -= 3
    } else if (handles.some((h) => fullHaystack.includes(h))) {
      // Medium bonus: handle mentioned anywhere in text
      score -= 1
    }
  }

  // ── target person focus ──
  if (profile.bodyPeople.length > 0) {
    const targets = targetPersonHandles(profile)
    if (targets.some((handle) => handleInTitlePath(hit, handle))) {
      score -= 4
    } else if (hit.kind === "people") {
      score += 3
    } else if (hit.kind === "core" && !coreIntent) {
      score += 3.5
    }
  }

  // ── semantic similarity ──
  if (semanticSimilarity !== undefined) {
    score -= semanticSimilarity * 2.5
    if (hit.kind === "core" && !coreIntent && semanticSimilarity < MEMORY_SEMANTIC_STRONG_SIMILARITY) {
      score += 1.25
    }
  } else {
    score += 0.75
    if (hit.kind === "core" && !coreIntent) score += 1.25
  }

  // ── core penalty when no core intent ──
  if (hit.kind === "core" && !coreIntent) score += 0.75

  return score
}

// ── relevance gating ───────────────────────────────────────────────────

/**
 * Signal summarizing how the top hit overlaps with the query.
 */
type RelevanceSignal = {
  overlap: number
  strongOverlap: boolean
  bodyOverlap: number
  senderMatch: boolean
  semanticStrong: boolean
}

function computeRelevance(hit: MemoryHit, profile: MemorySearchProfile): RelevanceSignal {
  const haystack = hitHaystack(hit)
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
  const titleLower = hitTitlePath(hit)
  const pathHaystack = hit.path.toLowerCase()
  const senderMatch =
    handles.length > 0 &&
    handles.some((h) => titleLower.includes(h) || pathHaystack.includes(`/${h}.md`) || haystack.includes(h))

  return {
    overlap,
    strongOverlap,
    bodyOverlap,
    senderMatch,
    semanticStrong: (hit.semanticSimilarity ?? 0) >= MEMORY_SEMANTIC_STRONG_SIMILARITY,
  }
}

/**
 * Decides whether the search results are relevant enough to inject into the conversation.
 *
 * @param hits - Scored hits (first element is the best match).
 * @param profile - Search profile.
 * @returns `true` when the hits should be injected.
 */
function isRelevant(hits: MemoryHit[], profile: MemorySearchProfile): boolean {
  if (hits.length === 0) return false

  const signal = computeRelevance(hits[0]!, profile)

  // Person-oriented queries require informative body + some match
  if (profile.sender || profile.bodyPeople.length > 0) {
    const semanticRecallMatch =
      signal.semanticStrong && (profileHasExplicitRecallIntent(profile) || profile.bodyTokens.length >= 4)
    if (!profile.bodyInformative && !semanticRecallMatch) return false
    if (signal.senderMatch) return true
    if (signal.bodyOverlap >= 2) return true
    if (signal.bodyOverlap >= 1 && signal.strongOverlap) return true
    if (semanticRecallMatch) return true
    return false
  }

  // Event queries require at least one journal match
  if (profile.eventQuery && !profile.personQuery) {
    return (
      (signal.overlap >= 1 && hits.some((hit) => hit.kind === "journal")) ||
      hits.some((hit) => hit.kind === "journal" && (hit.semanticSimilarity ?? 0) >= MEMORY_SEMANTIC_STRONG_SIMILARITY)
    )
  }

  // Person queries require at least one people/core match
  if (profile.personQuery && !profile.eventQuery) {
    return (
      (signal.overlap >= 1 && hits.some((hit) => hit.kind === "people" || hit.kind === "core")) ||
      hits.some(
        (hit) =>
          (hit.kind === "people" || hit.kind === "core") &&
          (hit.semanticSimilarity ?? 0) >= MEMORY_SEMANTIC_STRONG_SIMILARITY,
      )
    )
  }

  // General queries need decent overlap
  if (signal.bodyOverlap >= 2) return true
  if (signal.bodyOverlap >= 1 && signal.strongOverlap) return true
  if (signal.overlap >= 2 && signal.strongOverlap) return true
  if (signal.semanticStrong) return true
  return false
}

// ── search profile ─────────────────────────────────────────────────────

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

async function knownPeopleHandles(aliasMap: Record<string, string[]>): Promise<Set<string>> {
  const handles = new Set<string>()
  if (await import("fs/promises").then((fs) => fs.access(PEOPLE_DIR).then(() => true, () => false))) {
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

/**
 * Builds a rich search profile from query parts for use in scoring and gating.
 *
 * @param parts - Structured query parts (sender, source, body).
 * @returns Search profile with resolved aliases, tokens, and intent classification.
 */
export async function buildSearchProfile(parts: {
  sender: string | null
  source: string | null
  body: string
}): Promise<MemorySearchProfile> {
  const aliasMap = await loadAliasMap()
  return buildSearchProfileWithContext(parts, aliasMap, await knownPeopleHandles(aliasMap))
}

function buildSearchProfileWithContext(
  parts: { sender: string | null; source: string | null; body: string },
  aliasMap: Record<string, string[]>,
  peopleHandles: Iterable<string>,
): MemorySearchProfile {
  const sender = parts.sender ? normalizeHandle(parts.sender) : null
  const senderAliases = resolveAliases(sender, aliasMap)
  const bodyTokens = parts.body ? tokensFromText(parts.body) : []

  const known = new Set(Array.from(peopleHandles, normalizeHandle).filter(Boolean))
  for (const [handle, aliases] of Object.entries(aliasMap)) {
    known.add(normalizeHandle(handle))
    for (const alias of aliases) known.add(normalizeHandle(alias))
  }
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
      /\b(what happened|when|yesterday|today|tonight|earlier|before|after|session|wake)\b/.test(
        normalized,
      ) ||
      /\b\d{4}-\d{2}-\d{2}\b/.test(normalized) ||
      /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized) ||
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
        normalized,
      ),
  }
}

// ── semantic queries ───────────────────────────────────────────────────

/**
 * Computes a semantic query signal using prototype embeddings for chatter/recall classification.
 *
 * @param memoryQuery - The search query string.
 * @returns Semantic signal with chatter and recall-intent similarity, or `null`.
 */
export async function semanticQuerySignal(memoryQuery: string): Promise<SemanticQuerySignal | null> {
  if (!isVecAvailable() || !embeddingsConfigured() || EMBEDDING_DIMENSIONS !== MEMORY_EMBEDDING_DIMENSIONS) return null
  const [vector] = await embedTexts([memoryQuery])
  if (!vector || vector.length !== MEMORY_EMBEDDING_DIMENSIONS) return null

  const rows = getDb()
    .prepare(`
      select p.category as category, v.distance as distance
      from memory_prototype_vec v
      join memory_embedding_prototypes p on p.id = v.rowid
      where v.embedding match ?
        and k = ?
      order by v.distance
    `)
    .all(new Float32Array(vector), 8) as Array<{ category: string; distance: number }>

  let chatterSimilarity: number | null = null
  let recallIntentSimilarity: number | null = null
  for (const row of rows) {
    const similarity = 1 - row.distance
    if (row.category === "chatter") chatterSimilarity = Math.max(chatterSimilarity ?? -Infinity, similarity)
    if (row.category === "recall_intent") {
      recallIntentSimilarity = Math.max(recallIntentSimilarity ?? -Infinity, similarity)
    }
  }

  return { vector, chatterSimilarity, recallIntentSimilarity }
}

/**
 * Determines whether a query should be skipped because it's chatter (e.g. "i love you")
 * rather than genuine recall intent.
 *
 * @param profile - Search profile.
 * @param signal - Semantic query signal.
 * @returns `true` when the query looks like chatter and should be skipped.
 */
export function shouldSkipForSemanticChatter(profile: MemorySearchProfile, signal: SemanticQuerySignal | null): boolean {
  if (!signal) return false
  if (profileHasExplicitRecallIntent(profile)) return false
  if (profile.bodyTokens.length > 5) return false
  const chatter = signal.chatterSimilarity ?? 0
  const recallIntent = signal.recallIntentSimilarity ?? 0
  return chatter >= MEMORY_CHATTER_SIMILARITY_THRESHOLD && recallIntent < MEMORY_RECALL_INTENT_SIMILARITY_THRESHOLD
}

// ── FTS query building ─────────────────────────────────────────────────

function buildSearchQuery(profile: MemorySearchProfile): string | null {
  if (profile.tokens.length === 0) return null
  return profile.tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ")
}

function semanticHitsForQuery(vector: number[], limit: number): MemoryHit[] {
  if (!isVecAvailable()) return []
  const rows = getDb()
    .prepare(`
      select
        c.id as chunkId,
        d.path as path,
        d.kind as kind,
        d.title as documentTitle,
        c.title as title,
        c.heading_path as headingPath,
        c.chunk_text as text,
        v.distance as rank,
        v.distance as semanticDistance
      from memory_chunk_vec v
      join memory_chunks c on c.id = v.rowid
      join memory_documents d on d.id = c.document_id
      where v.embedding match ?
        and k = ?
      order by v.distance
    `)
    .all(new Float32Array(vector), limit) as Array<MemoryHit & { semanticDistance: number }>

  return rows.map((row) => ({
    ...row,
    semanticSimilarity: 1 - row.semanticDistance,
  }))
}

function mergeSemanticHits(rows: MemoryHit[], vector: number[], limit: number): MemoryHit[] {
  const semanticRows = semanticHitsForQuery(vector, Math.max(limit * 16, 64))
  if (semanticRows.length === 0) return rows

  const byChunkId = new Map<number, MemoryHit>(rows.map((row) => [row.chunkId, { ...row }]))
  for (const semanticRow of semanticRows) {
    const existing = byChunkId.get(semanticRow.chunkId)
    byChunkId.set(
      semanticRow.chunkId,
      existing
        ? {
            ...existing,
            semanticDistance: semanticRow.semanticDistance,
            semanticSimilarity: semanticRow.semanticSimilarity,
          }
        : semanticRow,
    )
  }

  return Array.from(byChunkId.values())
}

// ── exact person hits ──────────────────────────────────────────────────

function exactPersonHits(profile: MemorySearchProfile): MemoryHit[] {
  if (profile.bodyPeople.length === 0) return []
  const db = getDb()
  const hits: MemoryHit[] = []
  const seen = new Set<number>()
  const stmt = db.prepare(`
    select
      c.id as chunkId,
      d.path as path,
      d.kind as kind,
      d.title as documentTitle,
      c.title as title,
      c.heading_path as headingPath,
      c.chunk_text as text,
      -10.0 as rank
    from memory_chunks c
    join memory_documents d on d.id = c.document_id
    where d.kind = 'people'
      and lower(d.path) like ?
    order by c.chunk_index
  `)

  for (const handle of profile.bodyPeople) {
    const rows = stmt.all(`%/people/${handle.toLowerCase()}.md`) as MemoryHit[]
    for (const row of rows) {
      if (seen.has(row.chunkId)) continue
      seen.add(row.chunkId)
      hits.push(row)
    }
  }
  return hits
}

// ── cooldown ───────────────────────────────────────────────────────────

function isCoolingDown(hit: MemoryHit, cooldowns: Record<number, number>, currentTurn: number): boolean {
  const lastTurn = cooldowns[hit.chunkId]
  if (typeof lastTurn !== "number") return false
  return currentTurn - lastTurn < MEMORY_RECALL_COOLDOWN_TURNS
}

// ── main search ────────────────────────────────────────────────────────

/**
 * Searches the memory index for hits matching a search profile.
 *
 * @param profile - Search profile with query signals.
 * @param cooldowns - Chunk id → last-recalled turn mapping.
 * @param currentTurn - Current conversation turn number.
 * @param limit - Maximum number of hits to return.
 * @param semanticSignal - Optional semantic signal for similarity scoring.
 * @returns Deduplicated, scored, and filtered memory hits.
 */
export async function searchMemory(
  profile: MemorySearchProfile,
  cooldowns: Record<number, number>,
  currentTurn: number,
  limit: number,
  semanticSignal: SemanticQuerySignal | null = null,
): Promise<MemoryHit[]> {
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

  // Inject exact person hits
  for (const hit of exactPersonHits(profile)) {
    if (rows.some((row) => row.chunkId === hit.chunkId)) continue
    rows.push(hit)
  }

  const candidateRows = semanticSignal ? mergeSemanticHits(rows, semanticSignal.vector, limit) : rows

  // Score all hits
  const scored = candidateRows.map((hit) => ({
    hit,
    score: scoreHit(hit, profile, hit.semanticSimilarity),
  }))

  // Filter by kind preference
  const kindFiltered =
    profile.personQuery && !profile.eventQuery
      ? (() => {
          const structured = scored.filter((s) => s.hit.kind === "people" || s.hit.kind === "core")
          return structured.length > 0 ? structured : scored
        })()
      : profile.eventQuery && !profile.personQuery
        ? (() => {
            const journal = scored.filter((s) => s.hit.kind === "journal")
            return journal.length > 0 ? journal : scored
          })()
        : scored

  // Sort by score (lower is better)
  kindFiltered.sort((a, b) => a.score - b.score)

  // Dedup with person-aware selection
  const deduped: MemoryHit[] = []
  const seenChunkIds = new Set<number>()
  const seenPaths = new Set<string>()

  const handles = targetPersonHandles(profile)
  const exactTargetAvailable =
    profile.bodyPeople.length > 0 && kindFiltered.some((s) => handles.some((handle) => handleInTitlePath(s.hit, handle)))

  // First pass: ensure each target handle gets a representative hit
  if (handles.length >= 2) {
    for (const handle of handles) {
      if (deduped.length >= limit) break
      const candidate = kindFiltered.find(
        (s) =>
          !seenChunkIds.has(s.hit.chunkId) &&
          !seenPaths.has(s.hit.path) &&
          !isCoolingDown(s.hit, cooldowns, currentTurn) &&
          handleInTitlePath(s.hit, handle),
      )
      if (!candidate) continue
      seenChunkIds.add(candidate.hit.chunkId)
      seenPaths.add(candidate.hit.path)
      deduped.push(candidate.hit)
    }
  }

  // Second pass: fill remaining slots
  for (const { hit } of kindFiltered) {
    if (deduped.length >= limit) break
    if (seenChunkIds.has(hit.chunkId)) continue
    if (isCoolingDown(hit, cooldowns, currentTurn)) continue

    const exactTargetMatch = profile.bodyPeople.length > 0 && handles.some((handle) => handleInTitlePath(hit, handle))
    if (exactTargetAvailable && !exactTargetMatch && hit.kind !== "journal") continue

    // Require at least one person mention for person-oriented queries
    if (profile.bodyPeople.length > 0 && !profile.bodyPeople.some((handle) => hitHaystack(hit).includes(handle))) continue

    const relevance = computeRelevance(hit, profile)
    if (
      hit.semanticSimilarity !== undefined &&
      hit.semanticSimilarity < MEMORY_SEMANTIC_MIN_SIMILARITY &&
      relevance.overlap === 0 &&
      relevance.bodyOverlap === 0 &&
      !relevance.senderMatch
    ) continue

    // Skip weak core hits without core intent
    if (
      semanticSignal &&
      hit.kind === "core" &&
      !profileHasCoreIntent(profile) &&
      (hit.semanticSimilarity ?? 0) < MEMORY_SEMANTIC_MIN_SIMILARITY
    ) continue

    seenChunkIds.add(hit.chunkId)
    deduped.push(hit)
  }

  return deduped
}

// ── formatting ─────────────────────────────────────────────────────────

/**
 * Formats a memory hit into a human-readable source label.
 *
 * @param hit - Memory hit.
 * @returns Formatted source string.
 */
export function formatMemorySource(hit: MemoryHit): string {
  const relativePath = path.relative(HOME_DIR, hit.path)
  const pieces = [`[${hit.kind}]`, hit.documentTitle]
  if (hit.headingPath && hit.headingPath !== hit.documentTitle) pieces.push(hit.headingPath)
  pieces.push(relativePath)
  return pieces.join(" / ")
}

/**
 * Converts a raw hit into a public search result.
 *
 * @param hit - Memory hit.
 * @returns Search result with full chunk text.
 */
export function toMemorySearchResult(hit: MemoryHit): import("./shared").MemorySearchResult {
  const content = normalizeText(hit.text)
  return {
    chunkId: hit.chunkId,
    kind: hit.kind,
    path: hit.path,
    source: formatMemorySource(hit),
    title: hit.title,
    headingPath: hit.headingPath,
    content,
    preview: content,
  }
}

/**
 * Builds a formatted memory recall message from scored hits.
 *
 * @param hits - Hits to include.
 * @returns Formatted recall message.
 */
export function buildMemoryRecallMessage(hits: MemoryHit[]): string {
  const MEMORY_RECALL_HEADER = "[injected recalled memories]"
  const MEMORY_RECALL_NOTE =
    "Potentially relevant long-term notes. Use only if helpful; trust newer conversation details if anything conflicts."

  const lines = [MEMORY_RECALL_HEADER, MEMORY_RECALL_NOTE, ""]

  for (const hit of hits) {
    const source = formatMemorySource(hit)
    const body = normalizeText(hit.text)
    const block = `- ${source}\n  ${body}`
    lines.push(block)
  }

  return lines.join("\n").trim()
}

export { isRelevant }

export const __memorySearchTest = { buildSearchProfileWithContext }
