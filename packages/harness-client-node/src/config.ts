import fs from "node:fs"
import path from "node:path"

const DEFAULT_IMAGE_MAX_BYTES = 1_000_000
const DEFAULT_READ_BLOB_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_LINES = 150
const DEFAULT_MAX_LINE_LENGTH = 2_000
const DEFAULT_MAX_RESULT_BYTES = 512_000
const VERBOSE_MAX_LINES = 40

const VERBOSE_PATTERNS: RegExp[] = [
  /\bapt(-get)?\s+(install|upgrade|update|dist-upgrade|autoremove)\b/,
  /\bpip3?\s+install\b/,
  /\bnpm\s+(install|ci|i)\b/,
  /\byarn\s+(install|add)\b/,
  /\bcargo\s+(build|install|fetch|update)\b/,
  /\bgo\s+(get|install|build|mod\s+download)\b/,
  /\bdpkg\b/,
  /\bsnap\s+install\b/,
]

export type NodeToolRuntimeOptions = {
  workspaceRoot?: string
  home?: string
  imageRoot?: string
  imageMaxBytes?: number
  maxLineLength?: number
  maxResultBytes?: number
  readBlobMaxBytes?: number
  containerName?: string
  containerUser?: string
  shellEnvironment?: Record<string, string | undefined>
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
export const DEFAULT_FILE_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 10 * 60_000

export let CLIENT_WORKSPACE_ROOT = ""
export let CLIENT_HOME = ""
export let IMAGE_ROOT = ""
export let IMAGE_MAX_BYTES = DEFAULT_IMAGE_MAX_BYTES
export let MAX_LINE_LENGTH = DEFAULT_MAX_LINE_LENGTH
export let MAX_RESULT_BYTES = DEFAULT_MAX_RESULT_BYTES
export let READ_BLOB_MAX_BYTES = DEFAULT_READ_BLOB_MAX_BYTES
export let USE_DOCKER_SHELL = false
export let CONTAINER_NAME = "harness"
export let CONTAINER_USER = "harness"
export let SHELL_ENV: Record<string, string> = {}
export let NODE_TOOL_RUNTIME_GENERATION = 0

const SAFE_SHELL_ENV = new Set([
  "COLORTERM",
  "DISPLAY",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
])

function defaultShellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue
    if (SAFE_SHELL_ENV.has(key) || key.startsWith("LC_")) env[key] = value
  }
  return env
}

function parseShellEnvironment(value: string | undefined): Record<string, string | undefined> | undefined {
  if (!value?.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HARNESS_SHELL_ENV_JSON must be an object of strings")
  }
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error(`HARNESS_SHELL_ENV_JSON.${key} must be a string`)
    env[key] = item
  }
  return env
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function environmentOptions(): NodeToolRuntimeOptions {
  const containerName = process.env.HARNESS_CONTAINER?.trim()
  const containerUser = process.env.HARNESS_CONTAINER_USER?.trim()
  const workspaceRoot = process.env.HARNESS_CLIENT_WORKSPACE?.trim()
  const home = process.env.HARNESS_CLIENT_HOME?.trim()
  const imageRoot = process.env.HARNESS_IMAGE_ROOT?.trim()
  const shellEnvironment = parseShellEnvironment(process.env.HARNESS_SHELL_ENV_JSON)
  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(home ? { home } : {}),
    ...(imageRoot ? { imageRoot } : {}),
    imageMaxBytes: Number(process.env.HARNESS_IMAGE_MAX_BYTES),
    readBlobMaxBytes: Number(process.env.HARNESS_READ_BLOB_MAX_BYTES),
    maxLineLength: Number(process.env.HARNESS_MAX_LINE_LENGTH),
    maxResultBytes: Number(process.env.HARNESS_MAX_RESULT_BYTES),
    ...(containerName ? { containerName } : {}),
    ...(containerUser ? { containerUser } : {}),
    ...(shellEnvironment ? { shellEnvironment } : {}),
  }
}

export function configureNodeToolRuntime(options: NodeToolRuntimeOptions = {}): number {
  const defaults = environmentOptions()
  const containerName = options.containerName?.trim() || defaults.containerName?.trim() || ""
  const containerUser = options.containerUser?.trim() || defaults.containerUser?.trim() || ""
  if (Boolean(containerName) !== Boolean(containerUser)) {
    throw new Error("container name and container user must be configured together")
  }
  USE_DOCKER_SHELL = Boolean(containerName && containerUser)
  CONTAINER_NAME = containerName || "harness"
  CONTAINER_USER = containerUser || "harness"

  const configuredRoot = options.workspaceRoot?.trim() || defaults.workspaceRoot?.trim()
  const fallbackRoot = USE_DOCKER_SHELL ? `/home/${CONTAINER_USER}` : process.env.INIT_CWD ?? process.cwd()
  if (USE_DOCKER_SHELL) {
    CLIENT_WORKSPACE_ROOT = path.posix.normalize(configuredRoot || fallbackRoot)
  } else {
    const resolvedRoot = path.resolve(configuredRoot || fallbackRoot)
    try {
      CLIENT_WORKSPACE_ROOT = fs.realpathSync.native(resolvedRoot)
    } catch {
      CLIENT_WORKSPACE_ROOT = resolvedRoot
    }
  }
  CLIENT_HOME = USE_DOCKER_SHELL
    ? path.posix.normalize(options.home?.trim() || defaults.home?.trim() || `/home/${CONTAINER_USER}`)
    : path.resolve(options.home?.trim() || defaults.home?.trim() || process.env.HOME || CLIENT_WORKSPACE_ROOT)

  const configuredImageRoot = options.imageRoot?.trim() || defaults.imageRoot?.trim()
  const fallbackImageRoot = USE_DOCKER_SHELL
    ? path.posix.join(CLIENT_HOME, "images")
    : path.join(CLIENT_WORKSPACE_ROOT, "home", "images")
  IMAGE_ROOT = USE_DOCKER_SHELL
    ? path.posix.normalize(configuredImageRoot || fallbackImageRoot)
    : path.resolve(configuredImageRoot || fallbackImageRoot)
  if (!path.isAbsolute(IMAGE_ROOT)) throw new Error(`image root must be absolute: ${IMAGE_ROOT}`)

  IMAGE_MAX_BYTES = positiveInteger(options.imageMaxBytes, positiveInteger(defaults.imageMaxBytes, DEFAULT_IMAGE_MAX_BYTES))
  MAX_LINE_LENGTH = positiveInteger(options.maxLineLength, positiveInteger(defaults.maxLineLength, DEFAULT_MAX_LINE_LENGTH))
  MAX_RESULT_BYTES = positiveInteger(options.maxResultBytes, positiveInteger(defaults.maxResultBytes, DEFAULT_MAX_RESULT_BYTES))
  READ_BLOB_MAX_BYTES = positiveInteger(options.readBlobMaxBytes, positiveInteger(defaults.readBlobMaxBytes, DEFAULT_READ_BLOB_MAX_BYTES))
  SHELL_ENV = defaultShellEnvironment()
  for (const [key, value] of Object.entries(defaults.shellEnvironment ?? {})) {
    if (typeof value === "string") SHELL_ENV[key] = value
  }
  for (const [key, value] of Object.entries(options.shellEnvironment ?? {})) {
    if (typeof value === "string") SHELL_ENV[key] = value
    else delete SHELL_ENV[key]
  }
  SHELL_ENV.HOME = CLIENT_HOME
  NODE_TOOL_RUNTIME_GENERATION += 1
  return NODE_TOOL_RUNTIME_GENERATION
}

configureNodeToolRuntime()

export function resolveMaxLines(command: string, requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) return Math.trunc(requested)
  return VERBOSE_PATTERNS.some((pattern) => pattern.test(command)) ? VERBOSE_MAX_LINES : DEFAULT_MAX_LINES
}

export function normalizeTimeoutMs(requested: number | undefined, fallback: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(Math.trunc(requested), MAX_TIMEOUT_MS)
}
