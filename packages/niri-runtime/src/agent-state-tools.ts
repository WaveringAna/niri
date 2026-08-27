import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { applyHashlineEdit, hashlineLineHash as memoryLineHash } from "../../harness-client-node/src/hashline"
export { applyHashlineEdit, hashlineLineHash as memoryLineHash } from "../../harness-client-node/src/hashline"
import { NIRI_HOME } from "./agent-config"

const MAX_STATE_WRITE_BYTES = 256_000
const MAX_MEMORY_GREP_MATCHES = 80
const MAX_MEMORY_GREP_BODY_BYTES = 20_000
const MAX_MEMORY_GREP_RESULT_BYTES = 32_000
const MAX_MEMORY_GREP_QUERY_BYTES = 1_000
const MAX_MEMORY_GREP_LINE_CHARS = 1_000
const MAX_MEMORY_GREP_OMITTED_FILE_MARKERS = 24
const MEMORY_ROOT = path.join(NIRI_HOME, "memories")


function validateMarkdown(content: string): void {
  const headerMatch = /^#{1,6}[^\s#\r\n]/m.test(content)
  if (headerMatch) {
    throw new Error("Markdown validation failed: headers must have a space after the '#' characters (e.g. '## Header', not '##Header')")
  }
  const codeBlocks = content.match(/```/g)
  if (codeBlocks && codeBlocks.length % 2 !== 0) {
    throw new Error("Markdown validation failed: unclosed code block (odd number of '```' markers)")
  }
}

function validateContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required")
  if (Buffer.byteLength(content, "utf8") > MAX_STATE_WRITE_BYTES) {
    throw new Error(`content exceeds ${MAX_STATE_WRITE_BYTES} bytes`)
  }
  validateMarkdown(content)
  return content
}

/** Hashline content may be empty (line deletion); non-empty content still must be valid markdown. */
function validateHashlineContent(content: unknown): string {
  if (typeof content !== "string") throw new Error("content is required")
  if (content.length === 0) return content
  if (Buffer.byteLength(content, "utf8") > MAX_STATE_WRITE_BYTES) {
    throw new Error(`content exceeds ${MAX_STATE_WRITE_BYTES} bytes`)
  }
  validateMarkdown(content)
  return content
}

function memoryPath(relativePath: unknown): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("path is required")
  const normalized = relativePath.trim().replace(/\\/g, "/")
  if (path.posix.isAbsolute(normalized) || path.posix.extname(normalized).toLowerCase() !== ".md") {
    throw new Error("memory path must be a relative Markdown file")
  }
  const resolved = path.resolve(MEMORY_ROOT, normalized)
  const relative = path.relative(MEMORY_ROOT, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("memory path escapes the agent memory directory")
  return resolved
}

async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function getWarningForFile(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 200_000) {
      return `\nWarning: File size is currently ${(stat.size / 1024).toFixed(1)} KB, which is close to the 256KB cap. Please consider archiving older entries.`
    }
  } catch {}
  return ""
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function prepareMemoryFile(filePath: string): Promise<void> {
  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const rootStat = await fs.lstat(MEMORY_ROOT)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("agent memory root must be a real directory")
  await fs.chmod(MEMORY_ROOT, 0o700)

  const parent = path.dirname(filePath)
  const relativeParent = path.relative(MEMORY_ROOT, parent)
  let current = MEMORY_ROOT
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("memory path contains a non-directory or symbolic link")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await fs.mkdir(current, { mode: 0o700 })
    }
  }

  const [realRoot, realParent] = await Promise.all([fs.realpath(MEMORY_ROOT), fs.realpath(parent)])
  const realRelative = path.relative(realRoot, realParent)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("memory path resolves outside the agent memory directory")
  }

  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error("memory file must not be a symbolic link")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/**
 * Reads the server-owned soul.md. When hashline is true, each line is prefixed
 * with its `<line>#<hash>` anchor for soul_write hashline edits.
 */
export async function readSoul(hashline?: unknown): Promise<string> {
  const filePath = path.join(NIRI_HOME, "soul.md")
  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`soul file does not exist: ${filePath}`)
    }
    throw error
  }
  if (hashline !== true) return content
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.map((line, i) => `${i + 1}#${memoryLineHash(line)} ${line}`).join("\n")
}

export async function writeSoul(content: unknown, mode: unknown, target?: unknown): Promise<string> {
  const filePath = path.join(NIRI_HOME, "soul.md")
  const value = mode === "hashline" ? validateHashlineContent(content) : validateContent(content)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await backupFile(filePath)

  if (mode === "append") {
    const handle = await fs.open(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(value, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.chmod(filePath, 0o600)
    const warning = await getWarningForFile(filePath)
    return `appended ${filePath}${warning}`
  } else if (mode === "patch") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'patch'")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot patch non-existent file: ${filePath}`)
      }
      throw error
    }

    const index = existing.indexOf(target)
    if (index === -1) {
      throw new Error(`patch failed: target text not found in ${filePath}`)
    }
    if (existing.indexOf(target, index + target.length) !== -1) {
      throw new Error(`patch failed: target text is not unique in ${filePath}`)
    }

    const newContent = existing.slice(0, index) + value + existing.slice(index + target.length)
    await replaceFile(filePath, newContent)
    const warning = await getWarningForFile(filePath)
    return `patched ${filePath}${warning}`
  } else if (mode === "hashline") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'hashline' (use <line>#<hash> or <line>#<hash>-<line>#<hash> from a hashline-enabled read)")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot edit non-existent file: ${filePath}`)
      }
      throw error
    }

    const edit = applyHashlineEdit(existing, target, value)
    await replaceFile(filePath, edit.result)
    const warning = await getWarningForFile(filePath)
    return `edited ${filePath} (replaced lines ${edit.startLine}\u2013${edit.endLine})${warning}`
  } else {
    throw new Error("mode must be append, patch, or hashline")
  }
}

export async function writeMemory(
  relativePath: unknown,
  content: unknown,
  mode: unknown,
  target?: unknown,
): Promise<string> {
  const filePath = memoryPath(relativePath)
  const value = mode === "hashline" ? validateHashlineContent(content) : validateContent(content)
  await prepareMemoryFile(filePath)
  if (filePath.endsWith("core.md")) {
    await backupFile(filePath)
  }

  if (mode === "append") {
    const handle = await fs.open(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(value, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.chmod(filePath, 0o600)
    const warning = await getWarningForFile(filePath)
    return `appended ${filePath}${warning}`
  } else if (mode === "patch") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'patch'")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot patch non-existent file: ${filePath}`)
      }
      throw error
    }

    const index = existing.indexOf(target)
    if (index === -1) {
      throw new Error(`patch failed: target text not found in ${filePath}`)
    }
    if (existing.indexOf(target, index + target.length) !== -1) {
      throw new Error(`patch failed: target text is not unique in ${filePath}`)
    }

    const newContent = existing.slice(0, index) + value + existing.slice(index + target.length)
    await replaceFile(filePath, newContent)
    const warning = await getWarningForFile(filePath)
    return `patched ${filePath}${warning}`
  } else if (mode === "hashline") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'hashline' (use <line>#<hash> or <line>#<hash>-<line>#<hash> from a hashline-enabled read)")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot edit non-existent file: ${filePath}`)
      }
      throw error
    }

    const edit = applyHashlineEdit(existing, target, value)
    await replaceFile(filePath, edit.result)
    const warning = await getWarningForFile(filePath)
    return `edited ${filePath} (replaced lines ${edit.startLine}\u2013${edit.endLine})${warning}`
  } else {
    throw new Error("mode must be append, patch, or hashline")
  }
}

function isGarbageFile(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === ".git" ||
    lower === ".ds_store" ||
    lower === ".gitignore" ||
    lower === ".gitattributes" ||
    lower.startsWith(".codex-tmp") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".temp")
  )
}

async function getFilesRecursively(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (isGarbageFile(entry.name)) return []
      const res = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return getFilesRecursively(res)
      } else {
        return [res]
      }
    })
  )
  return files.flat()
}

export async function readMemory(relativePath: unknown, startLine?: unknown, endLine?: unknown, hashline?: unknown): Promise<string> {
  const filePath = memoryPath(relativePath)
  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`memory file does not exist: ${filePath}`)
    }
    throw error
  }

  const start = Math.max(1, Math.trunc(Number(startLine)) || 1)
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const totalLines = lines.length

  const startIdx = start - 1
  const end = endLine !== undefined
    ? Math.max(start, Math.trunc(Number(endLine)) || start)
    : start + 99
  const searchStartIdx = end

  let effectiveEnd: number
  let foundHeaderIdx = -1
  for (let i = searchStartIdx; i < totalLines; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      foundHeaderIdx = i
      break
    }
  }

  if (foundHeaderIdx !== -1) {
    effectiveEnd = foundHeaderIdx
  } else {
    effectiveEnd = Math.min(searchStartIdx, totalLines)
  }

  const annotate = hashline === true
  let selected = lines
    .slice(startIdx, effectiveEnd)
    .map((line, i) => (annotate ? `${startIdx + i + 1}#${memoryLineHash(line)} ${line}` : line))
    .join("\n")
  if (effectiveEnd < totalLines) {
    if (foundHeaderIdx !== -1) {
      selected += `\n\n[Note: Content stopped before the next section header on line ${effectiveEnd + 1}. To read further, call 'memory_read' with start_line=${effectiveEnd + 1}.]`
    } else {
      selected += `\n\n[Note: Content stopped due to the 100-line read limit. To read further, call 'memory_read' with start_line=${effectiveEnd + 1}.]`
    }
  }

  const rangeStr = `lines ${start}–${effectiveEnd}`
  const totalStr = totalLines > 0 ? ` of ${totalLines} total` : ""
  return `[${relativePath}  ${rangeStr}${totalStr}]\n${selected}`
}

export async function listMemory(): Promise<string> {
  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const absoluteFiles = await getFilesRecursively(MEMORY_ROOT)
  const relativeFiles = absoluteFiles.map((file) => path.relative(MEMORY_ROOT, file))
  
  if (relativeFiles.length === 0) {
    return "(no memories found)"
  }
  return relativeFiles.sort().join("\n")
}

export async function grepMemory(query: unknown, caseInsensitive?: unknown): Promise<string> {
  if (typeof query !== "string" || !query) {
    throw new Error("query is required")
  }
  if (Buffer.byteLength(query, "utf8") > MAX_MEMORY_GREP_QUERY_BYTES) {
    throw new Error(`query exceeds ${MAX_MEMORY_GREP_QUERY_BYTES} bytes`)
  }
  const isCaseInsensitive = caseInsensitive === true

  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const absoluteFiles = await getFilesRecursively(MEMORY_ROOT)

  const matches: Array<{ path: string; line: number; hash: string; content: string }> = []
  const searchQuery = isCaseInsensitive ? query.toLowerCase() : query

  for (const file of absoluteFiles.sort()) {
    const relativePath = path.relative(MEMORY_ROOT, file)
    let content: string
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }

    const lines = content.split("\n")
    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const line = lines[lineNum - 1]!
      const lineToSearch = isCaseInsensitive ? line.toLowerCase() : line
      if (lineToSearch.includes(searchQuery)) {
        matches.push({ path: relativePath, line: lineNum, hash: memoryLineHash(line), content: line })
      }
    }
  }

  if (matches.length === 0) {
    return "(no matches found)"
  }

  const fullResult = matches
    .map((match) => `${match.path}:${match.line}#${match.hash}: ${match.content}`)
    .join("\n")
  if (matches.length <= MAX_MEMORY_GREP_MATCHES && Buffer.byteLength(fullResult, "utf8") <= MAX_MEMORY_GREP_RESULT_BYTES) {
    return fullResult
  }

  const shown: typeof matches = []
  const body: string[] = []
  let bodyBytes = 0
  let abbreviatedLines = 0
  for (const match of matches) {
    if (shown.length >= MAX_MEMORY_GREP_MATCHES) break
    const abbreviated = match.content.length > MAX_MEMORY_GREP_LINE_CHARS
    const content = abbreviated
      ? `${match.content.slice(0, MAX_MEMORY_GREP_LINE_CHARS)}… [line abbreviated; use memory_read({"path":${JSON.stringify(match.path)},"start_line":${match.line},"end_line":${match.line},"hashline":true})]`
      : match.content
    const rendered = `${match.path}:${match.line}#${match.hash}: ${content}`
    const renderedBytes = Buffer.byteLength(rendered, "utf8") + (body.length > 0 ? 1 : 0)
    if (bodyBytes + renderedBytes > MAX_MEMORY_GREP_BODY_BYTES) break
    body.push(rendered)
    shown.push(match)
    bodyBytes += renderedBytes
    if (abbreviated) abbreviatedLines++
  }

  const shownSet = new Set(shown)
  const omitted = matches.filter((match) => !shownSet.has(match))
  const omittedByFile = new Map<string, { count: number; min: number; max: number; first: number }>()
  for (const match of omitted) {
    const current = omittedByFile.get(match.path)
    if (current) {
      current.count++
      current.min = Math.min(current.min, match.line)
      current.max = Math.max(current.max, match.line)
    } else {
      omittedByFile.set(match.path, { count: 1, min: match.line, max: match.line, first: match.line })
    }
  }

  const header = `[memory_grep query=${JSON.stringify(query)}: showing ${shown.length} of ${matches.length} matches across ${new Set(matches.map((match) => match.path)).size} files; ${omitted.length} matches omitted; ${abbreviatedLines} shown lines abbreviated]`
  let result = `${header}\n${body.join("\n")}\n\n[bounded memory_grep result; omitted match ranges and targeted reads:`
  const finalHint = "\nuse a narrower memory_grep query or the memory_read calls above instead of repeating this broad search.\n]"
  let listedFiles = 0
  const omittedFiles = [...omittedByFile.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  for (const [relativePath, range] of omittedFiles.slice(0, MAX_MEMORY_GREP_OMITTED_FILE_MARKERS)) {
    const marker = `\n- ${relativePath}: ${range.count} omitted matches in lines ${range.min}-${range.max}; memory_read({"path":${JSON.stringify(relativePath)},"start_line":${range.first},"end_line":${Math.min(range.first + 99, range.max)},"hashline":true})`
    if (Buffer.byteLength(result + marker + finalHint, "utf8") > MAX_MEMORY_GREP_RESULT_BYTES) break
    result += marker
    listedFiles++
  }
  if (omittedFiles.length > listedFiles) {
    const additional = `\n- ${omittedFiles.length - listedFiles} additional files contain omitted matches; narrow the query to obtain their path:line#hash markers.`
    if (Buffer.byteLength(result + additional + finalHint, "utf8") <= MAX_MEMORY_GREP_RESULT_BYTES) {
      result += additional
    }
  }
  result += finalHint
  return result
}

export const __agentStateToolsTest = { memoryPath }
