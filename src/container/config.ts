import path from "path"

const configuredContainerName = (process.env.NIRI_CONTAINER ?? "").trim()
const configuredContainerUser = (process.env.NIRI_USER ?? "").trim()

/** Whether command execution should go through Docker instead of a local shell. */
export const USE_DOCKER_SHELL = configuredContainerName.length > 0 && configuredContainerUser.length > 0
/** Docker container name used for command execution. */
export const CONTAINER_NAME = configuredContainerName || "niri"
/** Linux user inside the container used for command execution. */
export const CONTAINER_USER = configuredContainerUser || "niri"
/** Repository fallback home used when a local OS home is unavailable. */
export const REPO_HOME_DIR = path.resolve(process.cwd(), "home")
/** Harness home for soul, memories, and local databases. */
export const HOME_DIR = USE_DOCKER_SHELL ? REPO_HOME_DIR : path.resolve(process.env.HOME ?? REPO_HOME_DIR)

/** Absolute image root allowed for `image_tool` operations. */
export const IMAGE_ROOT = (() => {
  const configured = (process.env.IMAGE_ROOT ?? "").trim()
  const root = configured || (USE_DOCKER_SHELL ? `/home/${CONTAINER_USER}/images` : path.resolve(process.cwd(), "home", "images"))
  if (!root.startsWith("/")) {
    throw new Error(`IMAGE_ROOT must be an absolute path, got: ${root}`)
  }
  return path.posix.normalize(root)
})()

const DEFAULT_IMAGE_MAX_BYTES = 150_000
/** Maximum image size (bytes) accepted by `image_tool`. */
export const IMAGE_MAX_BYTES = (() => {
  const parsed = parseInt(process.env.IMAGE_TOOL_MAX_BYTES ?? `${DEFAULT_IMAGE_MAX_BYTES}`, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_MAX_BYTES
  return parsed
})()

/** Default max lines returned by shell enough for most output without flooding context. */
const DEFAULT_MAX_LINES = 150

/**
 * Commands that routinely produce thousands of lines of noise.
 * When matched, the default cap is tightened to VERBOSE_MAX_LINES.
 */
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

const VERBOSE_MAX_LINES = 40
/** Default timeout for shell command execution in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** Default timeout for file operations in milliseconds. */
export const DEFAULT_FILE_TIMEOUT_MS = 120_000
/** Upper bound for all tool timeouts in milliseconds. */
export const MAX_TIMEOUT_MS = 10 * 60_000

/**
 * Returns the effective image root path exposed to model/tool descriptions.
 *
 * @returns The normalized absolute image root path.
 */
export function imageRootForModelInput(): string {
  return IMAGE_ROOT
}

/**
 * Resolves the effective output line cap for a shell command.
 *
 * @param command - Command text used to detect verbose command patterns.
 * @param requested - Optional explicit line cap override.
 * @returns Effective max line count (`0` means no truncation).
 */
export function resolveMaxLines(command: string, requested?: number): number {
  if (requested !== undefined) return requested
  return VERBOSE_PATTERNS.some((p) => p.test(command)) ? VERBOSE_MAX_LINES : DEFAULT_MAX_LINES
}

/**
 * Normalizes a timeout value by applying defaults, integer coercion, and hard cap.
 *
 * @param requested - User-provided timeout value.
 * @param fallback - Default timeout to use when the provided value is invalid.
 * @returns A bounded timeout in milliseconds.
 */
export function normalizeTimeoutMs(requested: number | undefined, fallback: number): number {
  const numeric = Number(requested)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(Math.trunc(numeric), MAX_TIMEOUT_MS)
}
