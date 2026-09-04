import OpenAI from "openai"
import type { Message } from "@mira/agent-context"
import type { CompletionErrorKind } from "./types.js"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/**
 * Provider error classification.
 *
 * Ported verbatim from `@niri/runtime`'s `runner/util.ts`, which accumulated
 * these patterns against real failures from OpenAI, Anthropic, OpenRouter,
 * DeepSeek, and LM Studio. They are matched on message text because none of
 * these providers expose a stable machine-readable reason.
 */

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  if (!err.status || err.status < 400 || err.status >= 500) return false

  const text = apiErrorText(err)
  return /usage limit|quota|insufficient[_\s-]*quota|billing cycle|billing hard limit|spending limit|monthly limit|out of credits|no credits|credit balance|insufficient balance|balance (?:is )?(?:not enough|too low)|account balance/i.test(
    text,
  )
}

/**
 * Determines whether an error should be retried against the same provider.
 *
 * @param err - Error thrown by the active API call.
 * @returns `true` when a same-provider retry/backoff should be attempted.
 */
export function shouldRetryProvider(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    // 429 + 5xx = overloaded or down; 0/undefined = network-level failure
    if (!err.status || err.status === 429 || err.status >= 500) return true
    return false
  }
  return isTransientTransportError(err)
}

/**
 * Determines whether an error should trigger fallback model routing.
 *
 * @param err - Error thrown by the primary API call.
 * @returns `true` when fallback should be attempted.
 */
export function shouldFallback(err: unknown): boolean {
  return shouldRetryProvider(err) || isQuotaExhaustedError(err)
}

function apiErrorText(err: InstanceType<typeof OpenAI.APIError>): string {
  const parts: string[] = [err.message]
  if (typeof err.code === "string") parts.push(err.code)
  if (typeof err.type === "string") parts.push(err.type)
  if (typeof err.param === "string") parts.push(err.param)
  collectApiErrorText(err.error, parts)
  return parts.join("\n")
}

function collectApiErrorText(value: unknown, parts: string[], depth = 0): void {
  if (depth > 4 || value == null) return
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectApiErrorText(item, parts, depth + 1)
    return
  }
  if (typeof value !== "object") return

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    parts.push(key)
    collectApiErrorText(nested, parts, depth + 1)
  }
}

function errorCauseChainText(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err

  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    parts.push(current.name, current.message)
    const withMetadata = current as Error & { code?: unknown; cause?: unknown }
    if (typeof withMetadata.code === "string") parts.push(withMetadata.code)
    current = withMetadata.cause
  }

  return parts.join("\n")
}

/**
 * Detects retryable network/stream failures thrown below the OpenAI SDK.
 */
export function isTransientTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  const text = errorCauseChainText(err)
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated|socket hang up|other side closed|aborted/i.test(
    text,
  )
}

const PROMPT_TOO_LARGE_PHRASES = [
  "prompt exceeds max length",
  "prompt is too long",
  "context length",
  "maximum context",
  "context_length_exceeded",
  "too many tokens",
  "reduce the length",
  "prompt length",
  "input length",
  "too long for",
  "request too large",
]

const PROMPT_TOO_LARGE_CODES = new Set(["context_length_exceeded", "1261", "string_above_max_length"])

/**
 * Detects prompt-length-exceeded errors across OpenAI-compatible providers.
 *
 * @param err - API error from a chat completions request.
 * @returns `true` when the provider rejected the prompt as too large.
 */
export function isPromptTooLargeError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  if (err.status !== 400 && err.status !== 413) return false

  const errorRecord = err as unknown as { code?: unknown; error?: { code?: unknown; type?: unknown } }
  const rootCode = typeof errorRecord.code === "string" ? errorRecord.code.toLowerCase() : ""
  const innerCode = typeof errorRecord.error?.code === "string" ? (errorRecord.error.code as string).toLowerCase() : ""
  if (rootCode && PROMPT_TOO_LARGE_CODES.has(rootCode)) return true
  if (innerCode && PROMPT_TOO_LARGE_CODES.has(innerCode)) return true

  const message = (err.message || "").toLowerCase()
  return PROMPT_TOO_LARGE_PHRASES.some((phrase) => message.includes(phrase))
}

const CONTENT_FILTER_PHRASES = [
  "potentially unsafe or sensitive content",
  "sensitive content in input or generation",
  "content filter",
  "content_filter",
  "may generate sensitive content",
]

const CONTENT_FILTER_CODES = new Set(["1301", "content_filter"])

/**
 * Detects provider content-safety rejections (typically 400-class).
 *
 * These errors can stick across turns when the offending content lives in the
 * persisted conversation (e.g. a previously attached image); the caller is
 * expected to scrub the conversation before retrying.
 */
export function isContentFilterError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  if (err.status !== 400) return false

  const errorRecord = err as unknown as { code?: unknown; error?: { code?: unknown; type?: unknown } }
  const rootCode = typeof errorRecord.code === "string" ? errorRecord.code.toLowerCase() : ""
  const innerCode = typeof errorRecord.error?.code === "string" ? (errorRecord.error.code as string).toLowerCase() : ""
  const innerType = typeof errorRecord.error?.type === "string" ? (errorRecord.error.type as string).toLowerCase() : ""
  if (CONTENT_FILTER_CODES.has(rootCode) || CONTENT_FILTER_CODES.has(innerCode) || innerType === "content_filter") return true

  const message = apiErrorText(err).toLowerCase()
  return CONTENT_FILTER_PHRASES.some((phrase) => message.includes(phrase))
}

const IMAGE_PARSE_CODES = new Set(["1210"])

const IMAGE_PARSE_PHRASES = [
  "图片输入格式", // z.ai / GLM: image input format / parse error
  "图片解析",
  "图片格式",
  "image parse",
  "image format",
  "invalid image",
  "unable to process input image",
  "source image is unreachable",
  "failed to parse image",
  "decode image",
]

/**
 * Detects provider rejections caused by an unparseable/malformed image part
 * (e.g. z.ai/GLM code 1210 "图片输入格式/解析错误").
 *
 * Like content-filter errors, these stick across turns when the offending image
 * lives in the persisted conversation; the caller is expected to scrub the
 * conversation's image parts before retrying so the loop doesn't crash-loop.
 */
export function isImageParseError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  if (err.status !== 400) return false

  const errorRecord = err as unknown as { code?: unknown; error?: { code?: unknown } }
  const rootCode = typeof errorRecord.code === "string" ? errorRecord.code.toLowerCase() : ""
  const innerCode = typeof errorRecord.error?.code === "string" ? (errorRecord.error.code as string).toLowerCase() : ""
  if (rootCode && IMAGE_PARSE_CODES.has(rootCode)) return true
  if (innerCode && IMAGE_PARSE_CODES.has(innerCode)) return true

  const message = apiErrorText(err).toLowerCase()
  return IMAGE_PARSE_PHRASES.some((phrase) => message.includes(phrase.toLowerCase()))
}

const SCRUBBED_IMAGE_PLACEHOLDER = "[the system has rejected this :( its not your fault]"

/**
 * Replaces multimodal image parts in the conversation with a text placeholder.
 *
 * Used after a provider content-filter rejection so the offending image stops
 * being re-sent on every subsequent turn.
 *
 * @returns The number of image parts that were scrubbed.
 */
export function scrubImagesFromConversation(msgs: Message[]): number {
  let scrubbed = 0
  for (const msg of msgs) {
    const record = asRecord(msg)
    if (!record) continue
    const content = record.content
    if (!Array.isArray(content)) continue

    let changed = false
    const next: unknown[] = []
    for (const part of content) {
      const partRecord = asRecord(part)
      if (partRecord && partRecord.type === "image_url") {
        next.push({ type: "text", text: SCRUBBED_IMAGE_PLACEHOLDER })
        scrubbed++
        changed = true
        continue
      }
      next.push(part)
    }
    if (changed) record.content = next
  }
  return scrubbed
}

/**
 * Produces a concise, log-friendly error summary.
 *
 * @param err - Any thrown error-like value.
 * @returns A compact human-readable error string.
 */
export function errorSummary(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `${err.status} ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

const API_ERROR_DETAIL_MAX_CHARS = 4000

function truncateForLog(value: string): string {
  if (value.length <= API_ERROR_DETAIL_MAX_CHARS) return value
  return `${value.slice(0, API_ERROR_DETAIL_MAX_CHARS)}... [truncated ${value.length - API_ERROR_DETAIL_MAX_CHARS} chars]`
}

function stringifyForLog(value: unknown): string {
  if (typeof value === "string") return truncateForLog(value)
  try {
    return truncateForLog(JSON.stringify(value))
  } catch {
    return truncateForLog(String(value))
  }
}

function apiErrorRawMetadata(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined
  const metadata = (error as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return undefined
  return (metadata as { raw?: unknown }).raw
}

/**
 * Produces detailed API error lines for provider-specific diagnostics.
 *
 * Some OpenAI-compatible providers wrap the real upstream failure in
 * `error.metadata.raw`; include it explicitly so the root cause appears in logs.
 */
export function apiErrorDetails(err: unknown): string[] {
  if (!(err instanceof OpenAI.APIError)) return []

  const details = [
    `status=${err.status ?? "unknown"}`,
    `message=${err.message}`,
  ]
  if (err.code) details.push(`code=${err.code}`)
  if (err.type) details.push(`type=${err.type}`)
  if (err.param) details.push(`param=${err.param}`)
  if (err.requestID) details.push(`request_id=${err.requestID}`)

  const lines = [`[api] error details: ${details.join(" ")}`]

  if (err.error !== undefined) {
    lines.push(`[api] error body: ${stringifyForLog(err.error)}`)
  }

  const raw = apiErrorRawMetadata(err.error)
  if (raw !== undefined) {
    lines.push(`[api] provider raw: ${stringifyForLog(raw)}`)
  }

  return lines
}

function parseRetryAfterHeaderMs(value: string): number | null {
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000

  const asDate = Date.parse(value)
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now()
    if (delta > 0) return delta
  }

  return null
}

function parseResetTimestampMs(message: string): number | null {
  const resetAtMatch = message.match(/reset at\s+(\d{4}-\d{2}-\d{2})[ t](\d{2}:\d{2}:\d{2})/i)
  if (!resetAtMatch) return null

  const datePart = resetAtMatch[1]
  const timePart = resetAtMatch[2]
  if (!datePart || !timePart) return null

  const dateParts = datePart.split("-").map((part) => Number(part))
  const timeParts = timePart.split(":").map((part) => Number(part))
  if (dateParts.length !== 3 || timeParts.length !== 3) return null

  const [year, month, day] = dateParts as [number, number, number]
  const [hour, minute, second] = timeParts as [number, number, number]
  if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) return null

  // z.ai returns "reset at YYYY-MM-DD HH:mm:ss" in China Standard Time (UTC+8).
  // Convert that wall-clock value to UTC before calculating backoff.
  const chinaOffsetHours = 8
  const resetAtUtc = Date.UTC(year, month - 1, day, hour - chinaOffsetHours, minute, second)
  if (!Number.isFinite(resetAtUtc)) return null

  const delta = resetAtUtc - Date.now()
  if (delta <= 0) return null
  return delta
}

/**
 * Computes retry backoff milliseconds from API error metadata/content.
 *
 * @param err - Error returned by the API layer.
 * @returns Delay in milliseconds before retrying primary model calls.
 */
export function retryDelayMs(err: unknown): number {
  const defaultMs = 60_000
  if (!(err instanceof OpenAI.APIError)) return defaultMs

  const retryAfterHeader = err.headers?.["retry-after"]
  if (retryAfterHeader) {
    const parsed = parseRetryAfterHeaderMs(retryAfterHeader)
    if (parsed != null) return parsed
  }

  const resetAt = parseResetTimestampMs(err.message)
  if (resetAt != null) return resetAt

  const forHours = err.message.match(/for\s+(\d+)\s*hour/i)
  if (forHours) {
    const hours = Number(forHours[1])
    if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000
  }

  return defaultMs
}

/**
 * Coerces arbitrary values into a supported image detail level.
 *
 * @param value - Raw user/model-provided detail value.
 * @returns A valid image detail enum (`auto` by default).
/**
 * Normalizes any thrown value into a {@link CompletionErrorKind}.
 *
 * Order matters: quota is checked before rate-limiting because a quota error
 * also arrives as a 429, and prompt-size before content-filter because an
 * oversized prompt can trip a filter heuristic on the way out.
 */
export function classifyCompletionError(err: unknown): CompletionErrorKind {
  if (isQuotaExhaustedError(err)) return "quota_exhausted"
  if (isPromptTooLargeError(err)) return "prompt_too_large"
  if (isImageParseError(err)) return "image_parse"
  if (isContentFilterError(err)) return "content_filter"
  if (isTransientTransportError(err)) return "transient_transport"
  if (err instanceof OpenAI.APIError && err.status === 429) return "rate_limited"
  return "unknown"
}
