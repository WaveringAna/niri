/**
 * Discord REST client with retry logic.
 *
 * @module discord/rest
 */

import { REST, Routes } from "discord.js"

/**
 * Returns the configured Discord bot token.
 *
 * @returns Bot token string.
 * @throws When `DISCORD_BOT_TOKEN` is not set.
 */
export function getBotToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required")
  return token
}

/**
 * Creates an authenticated Discord REST client.
 *
 * @returns Configured REST instance.
 */
export function makeRestClient(): REST {
  return new REST({ version: "10" }).setToken(getBotToken())
}

/**
 * Extracts a machine-readable error code from a thrown value.
 *
 * @param err - Unknown thrown value.
 * @returns Error code string, or empty string if none found.
 */
export function errorCode(err: unknown): string {
  const value = err as { code?: unknown; cause?: unknown }
  if (typeof value?.code === "string") return value.code
  const cause = value?.cause as { code?: unknown } | undefined
  return typeof cause?.code === "string" ? cause.code : ""
}

/**
 * Extracts an HTTP status code from a thrown value.
 *
 * @param err - Unknown thrown value.
 * @returns Numeric status, or `null`.
 */
export function errorStatus(err: unknown): number | null {
  const value = err as { status?: unknown }
  return typeof value?.status === "number" && Number.isFinite(value.status) ? value.status : null
}

/**
 * Extracts a human-readable message from a thrown value.
 *
 * @param err - Unknown thrown value.
 * @returns Error message string.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Determines whether a Discord REST error is transient and worth retrying.
 *
 * @param err - Unknown thrown value.
 * @returns `true` for rate-limits, gateway errors, and network timeouts.
 */
export function isRetryableDiscordRestError(err: unknown): boolean {
  const code = errorCode(err)
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ECONNREFUSED"
  ) {
    return true
  }

  const status = errorStatus(err)
  return status === 429 || status === 502 || status === 503 || status === 504
}

const DISCORD_REST_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(10, Number.parseInt(process.env.DISCORD_REST_MAX_ATTEMPTS ?? "3", 10) || 3),
)
const DISCORD_REST_RETRY_BASE_MS = Math.max(
  100,
  Math.min(30_000, Number.parseInt(process.env.DISCORD_REST_RETRY_BASE_MS ?? "1000", 10) || 1000),
)

/**
 * Computes exponential backoff delay for a retry attempt.
 *
 * @param attempt - Zero-indexed attempt number.
 * @returns Delay in milliseconds.
 */
export function retryDelayMs(attempt: number): number {
  return DISCORD_REST_RETRY_BASE_MS * 2 ** attempt
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Executes a Discord REST operation with automatic retry on transient errors.
 *
 * @param label - Human-readable label for log messages.
 * @param fn - Async function producing the REST result.
 * @returns Result of `fn`.
 * @throws The last error when all attempts fail.
 */
export async function withDiscordRestRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown

  for (let attempt = 0; attempt < DISCORD_REST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryableDiscordRestError(err) || attempt + 1 >= DISCORD_REST_MAX_ATTEMPTS) break

      const delayMs = retryDelayMs(attempt)
      console.warn(
        `[discord rest] ${label} failed (${errorCode(err) || errorStatus(err) || "unknown"}: ${errorMessage(err)}); retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
    }
  }

  throw lastErr
}

/**
 * Resolves the bot's own user id via the REST API.
 *
 * @param rest - Authenticated REST client.
 * @returns Bot user id string.
 * @throws When the API returns an unparseable response.
 */
export async function getBotUserId(rest: REST): Promise<string> {
  const me = (await withDiscordRestRetry("get current user", () => rest.get(Routes.user("@me")))) as { id?: unknown }
  const id = (await import("./parse")).asString(me?.id)
  if (!id) throw new Error("failed to resolve bot user id")
  return id
}
