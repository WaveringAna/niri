/**
 * Memory alias system — handle resolution, loading, and CRUD.
 *
 * @module memory/aliases
 */

import fs from "fs/promises"
import { ALIASES_FILE, MEMORIES_DIR, type AliasMap } from "./shared"
import { normalizeHandle } from "./shared"

export { normalizeHandle }

// ── caching ────────────────────────────────────────────────────────────

let aliasCache: { mtimeMs: number; map: AliasMap } | null = null

/**
 * Loads and caches the alias map from disk.
 *
 * @returns Alias map keyed by normalized handle.
 */
export async function loadAliasMap(): Promise<AliasMap> {
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

/**
 * Persists the alias map to disk and invalidates the cache.
 *
 * @param map - Alias map to write.
 */
async function writeAliasMap(map: AliasMap): Promise<void> {
  await fs.mkdir(MEMORIES_DIR, { recursive: true })
  const sorted: AliasMap = {}
  for (const key of Object.keys(map).sort()) sorted[key] = [...map[key]!].sort()
  await fs.writeFile(ALIASES_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8")
  aliasCache = null
}

/**
 * Resolves all transitive aliases for a handle via BFS traversal.
 *
 * @param handle - Starting handle (or `null`).
 * @param map - Alias map to traverse.
 * @returns All reachable alias handles (not including the start).
 */
export function resolveAliases(handle: string | null, map: AliasMap): string[] {
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

// ── public CRUD ────────────────────────────────────────────────────────

/**
 * Lists all current handle aliases.
 *
 * @returns Full alias map.
 */
export async function listAliases(): Promise<AliasMap> {
  return loadAliasMap()
}

/**
 * Links a handle to a canonical name.
 *
 * @param handle - Handle to alias.
 * @param canonical - Canonical name to link.
 * @returns Updated alias map.
 */
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

/**
 * Removes one or all aliases for a handle.
 *
 * @param handle - Handle to modify.
 * @param canonical - Specific alias to remove (omit to clear all).
 * @returns Updated alias map.
 */
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
