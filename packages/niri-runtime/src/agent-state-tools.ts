import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { NIRI_HOME } from "./agent-config"

const MAX_STATE_WRITE_BYTES = 256_000
const MEMORY_ROOT = path.join(NIRI_HOME, "memories")

function validateContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required")
  if (Buffer.byteLength(content, "utf8") > MAX_STATE_WRITE_BYTES) {
    throw new Error(`content exceeds ${MAX_STATE_WRITE_BYTES} bytes`)
  }
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

export async function writeSoul(content: unknown): Promise<string> {
  const filePath = path.join(NIRI_HOME, "soul.md")
  await replaceFile(filePath, validateContent(content))
  return `updated ${filePath}`
}

export async function writeMemory(relativePath: unknown, content: unknown, mode: unknown): Promise<string> {
  const filePath = memoryPath(relativePath)
  const value = validateContent(content)
  await prepareMemoryFile(filePath)
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
  } else if (mode === "replace") {
    await replaceFile(filePath, value)
  } else {
    throw new Error("mode must be append or replace")
  }
  return `${mode}d ${filePath}`
}

export const __agentStateToolsTest = { memoryPath }
