import fs from "fs/promises"
import { randomUUID } from "node:crypto"
import path from "path"
import { fileURLToPath } from "node:url"
import OpenAI from "openai"
import { AGENT_ID, NIRI_HOME } from "../agent-config"
import { openAIHeaders, openAIUserAgent } from "../openai-headers"
import type { Message } from "../types"
import type { ImageDetail } from "./types"
import type { ToolArgs } from "./loop-shared"
import { createNiriToolCatalog } from "./tool-catalog"

const HOME_DIR = NIRI_HOME
export const AGENT_STATE_DIR = path.resolve(process.env.NIRI_AGENT_STATE_DIR ?? path.join(NIRI_HOME, "state"))
export const SESSION_FILE = path.join(AGENT_STATE_DIR, "session.json")
export const REST_SNAPSHOT_FILE = path.join(AGENT_STATE_DIR, "rest-snapshot.json")
export const PRIMARY_FAILOVER_FILE = path.join(AGENT_STATE_DIR, "primary-failover.json")
const LEGACY_PROJECT_ROOT = path.resolve(
  process.env.NIRI_LEGACY_STATE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."),
)
const LEGACY_STATE_FILES = ["session.json", "rest-snapshot.json", "primary-failover.json"] as const
const LEGACY_MIGRATION_MARKER = path.join(AGENT_STATE_DIR, "legacy-root-snapshots-migrated.json")
let legacyMigration: Promise<void> | null = null

async function ensureAgentStateDir(): Promise<void> {
  await fs.mkdir(AGENT_STATE_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(AGENT_STATE_DIR, 0o700)
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await ensureAgentStateDir()
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    const handle = await fs.open(temporary, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
    await fs.chmod(filePath, 0o600)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * Copies (never deletes) the old repo-root snapshots into an agent-owned
 * state directory. The marker stops a later `rest` from resurrecting a
 * cleared legacy session, while preserving the old summary chain as a backup.
 */
async function migrateLegacySnapshots(): Promise<void> {
  if (legacyMigration) return legacyMigration
  legacyMigration = (async () => {
    await ensureAgentStateDir()
    if (process.env.NIRI_MIGRATE_LEGACY_STATE?.trim().toLowerCase() === "false") return
    if (await fs.access(LEGACY_MIGRATION_MARKER).then(() => true).catch(() => false)) return

    const migrated: string[] = []
    for (const name of LEGACY_STATE_FILES) {
      const target = path.join(AGENT_STATE_DIR, name)
      const legacy = path.join(LEGACY_PROJECT_ROOT, name)
      const targetExists = await fs.access(target).then(() => true).catch(() => false)
      const legacyExists = await fs.access(legacy).then(() => true).catch(() => false)
      if (!targetExists && legacyExists) {
        await fs.copyFile(legacy, target)
        await fs.chmod(target, 0o600)
        migrated.push(name)
      }
    }
    await writePrivateFile(
      LEGACY_MIGRATION_MARKER,
      `${JSON.stringify({ migratedAt: new Date().toISOString(), migrated })}\n`,
    )
    if (migrated.length) console.log(`[runner] migrated legacy snapshots into ${AGENT_STATE_DIR}: ${migrated.join(", ")}`)
  })()
  return legacyMigration
}

export const CONTEXT_COMPACT_TRIGGER_TOKENS = parseInt(process.env.CONTEXT_COMPACT_TRIGGER_TOKENS ?? "90000")
export const CONTEXT_COMPACT_HARD_TRIGGER_TOKENS = Math.max(
  CONTEXT_COMPACT_TRIGGER_TOKENS + 1,
  Number.parseInt(process.env.CONTEXT_COMPACT_HARD_TRIGGER_TOKENS ?? "115000", 10) || 115_000,
)
export const CONTEXT_COMPACT_MIN_NEW_MESSAGES = Math.max(
  1,
  Number.parseInt(process.env.CONTEXT_COMPACT_MIN_NEW_MESSAGES ?? "24", 10) || 24,
)
export const PRIMARY_QUOTA_RETRY_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PRIMARY_QUOTA_RETRY_MS ?? `${24 * 60 * 60 * 1000}`, 10) || 24 * 60 * 60 * 1000,
)

const NIRI_ENV = (process.env.NIRI_ENV ?? "default").trim().toLowerCase()
export const USE_FALLBACK = NIRI_ENV === "local"

/** Display name for the agent, used in the summarizer prompt and grounding. */
export const AGENT_NAME = (process.env.AGENT_NAME ?? "").trim() || "niri"

export const API_BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
export const MODEL = process.env.MODEL ?? ""
export const PRIMARY_PROVIDER_REQUIRES_REASONING_REPLAY =
  API_BASE.toLowerCase().includes("deepseek") || MODEL.toLowerCase().includes("deepseek")
const DEFAULT_FALLBACK_BASE = "http://localhost:1234/v1"
const isLikelyLocalBase = (baseUrl: string): boolean => {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}
const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false
  return fallback
}

/** Controls whether model reasoning/thinking is requested and streamed to clients. */
export const ENABLE_THINKING = parseBooleanEnv(process.env.ENABLE_THINKING, true)
const parseToolChoiceEnv = (value: string | undefined, fallback: "required" | "auto" | "none"): "required" | "auto" | "none" => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "required" || normalized === "auto" || normalized === "none") return normalized
  return fallback
}

export const FALLBACK_BASE =
  process.env.FALLBACK_OPENAI_BASE_URL ?? process.env.OPENROUTER_BASE_URL ?? process.env.LMSTUDIO_BASE_URL ?? DEFAULT_FALLBACK_BASE
export const FALLBACK_MODEL =
  process.env.FALLBACK_MODEL ?? process.env.OPENROUTER_MODEL ?? process.env.LMSTUDIO_MODEL ?? "zai-org/glm-4.7-flash"
export const FALLBACK_PROVIDER_REQUIRES_REASONING_REPLAY =
  FALLBACK_BASE.toLowerCase().includes("deepseek") || FALLBACK_MODEL.toLowerCase().includes("deepseek")
export const SUMMARY_BASE =
  process.env.SUMMARY_OPENAI_BASE_URL ?? process.env.SUMMARY_BASE_URL ?? ""
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? ""
export const PRIMARY_TOOL_CHOICE = parseToolChoiceEnv(process.env.PRIMARY_TOOL_CHOICE ?? process.env.TOOL_CHOICE, "auto")
export const FALLBACK_TOOL_CHOICE = parseToolChoiceEnv(process.env.FALLBACK_TOOL_CHOICE, "auto")

export const USE_ANTHROPIC = parseBooleanEnv(process.env.USE_ANTHROPIC, false)
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ""
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? ""
export const ANTHROPIC_MAX_TOKENS = Math.max(1, Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "8192", 10)) || 8192
export const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION ?? "2024-10-22"
const FALLBACK_N_CTX = parseInt(process.env.FALLBACK_N_CTX ?? process.env.LMSTUDIO_N_CTX ?? "4096")
const FALLBACK_CONTEXT_MARGIN = parseInt(process.env.FALLBACK_CONTEXT_MARGIN ?? process.env.LMSTUDIO_CONTEXT_MARGIN ?? "256")
const FALLBACK_HARD_OVERFLOW_TOKENS = parseInt(
  process.env.FALLBACK_HARD_OVERFLOW_TOKENS ?? process.env.LMSTUDIO_HARD_OVERFLOW_TOKENS ?? "1024",
)
const FALLBACK_ENFORCE_CONTEXT_LIMIT = parseBooleanEnv(
  process.env.FALLBACK_ENFORCE_CONTEXT_LIMIT,
  isLikelyLocalBase(FALLBACK_BASE),
)

const fallbackApiKey =
  process.env.FALLBACK_OPENAI_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  process.env.LMSTUDIO_API_KEY ??
  process.env.OPENAI_API_KEY ??
  (isLikelyLocalBase(FALLBACK_BASE) ? "lm-studio" : "")
const summaryApiKey =
  process.env.SUMMARY_OPENAI_API_KEY ??
  process.env.SUMMARY_API_KEY ??
  (SUMMARY_BASE === process.env.OPENROUTER_BASE_URL ? process.env.OPENROUTER_API_KEY : undefined) ??
  (SUMMARY_BASE === process.env.LMSTUDIO_BASE_URL ? process.env.LMSTUDIO_API_KEY : undefined) ??
  process.env.OPENAI_API_KEY ??
  (SUMMARY_BASE && isLikelyLocalBase(SUMMARY_BASE) ? "lm-studio" : "")
const primaryHeaders = openAIHeaders([["User-Agent", openAIUserAgent()]])
const fallbackHeaders = openAIHeaders([
  ["HTTP-Referer", process.env.FALLBACK_OPENAI_REFERER],
  ["X-Title", process.env.FALLBACK_OPENAI_TITLE],
  ["User-Agent", openAIUserAgent(process.env.FALLBACK_OPENAI_USER_AGENT)],
])
const summaryHeaders = openAIHeaders([
  ["HTTP-Referer", process.env.SUMMARY_OPENAI_REFERER],
  ["X-Title", process.env.SUMMARY_OPENAI_TITLE],
  ["User-Agent", openAIUserAgent(process.env.SUMMARY_OPENAI_USER_AGENT)],
])

if (!USE_FALLBACK && !USE_ANTHROPIC && !MODEL) {
  throw new Error("MODEL is required unless fallback is forced (NIRI_ENV=local) or Anthropic is used (USE_ANTHROPIC=true).")
}

if (!USE_FALLBACK && !USE_ANTHROPIC && !process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required unless fallback is forced (NIRI_ENV=local) or Anthropic is used (USE_ANTHROPIC=true).")
}

if (USE_ANTHROPIC && !ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required when USE_ANTHROPIC=true.")
}

if (USE_ANTHROPIC && !ANTHROPIC_MODEL) {
  throw new Error("ANTHROPIC_MODEL is required when USE_ANTHROPIC=true.")
}

if (USE_FALLBACK && !fallbackApiKey) {
  throw new Error(
    "Fallback API key is required in local mode. Set FALLBACK_OPENAI_API_KEY (or OPENROUTER_API_KEY / LMSTUDIO_API_KEY).",
  )
}

if ((SUMMARY_BASE || SUMMARY_MODEL) && (!SUMMARY_BASE || !SUMMARY_MODEL || !summaryApiKey)) {
  throw new Error(
    "Summary provider requires SUMMARY_OPENAI_BASE_URL (or SUMMARY_BASE_URL), SUMMARY_MODEL, and SUMMARY_OPENAI_API_KEY (or SUMMARY_API_KEY).",
  )
}

export const client = USE_FALLBACK
  ? null
  : new OpenAI({
      baseURL: API_BASE,
      apiKey: process.env.OPENAI_API_KEY!,
      defaultHeaders: primaryHeaders,
    })

export const fallbackClient = new OpenAI({
  baseURL: FALLBACK_BASE,
  apiKey: fallbackApiKey || "lm-studio", // Keep LM Studio default when running against localhost.
  defaultHeaders: fallbackHeaders,
})

export const summaryClient =
  SUMMARY_BASE && SUMMARY_MODEL
    ? new OpenAI({
        baseURL: SUMMARY_BASE,
        apiKey: summaryApiKey,
        defaultHeaders: summaryHeaders,
      })
    : null

if (USE_ANTHROPIC) {
  console.log(`[config] primary=${ANTHROPIC_MODEL} @ ${ANTHROPIC_BASE_URL} (anthropic)`)
} else {
  console.log(`[config] primary=${MODEL} @ ${API_BASE}`)
}
console.log(`[config] fallback=${FALLBACK_MODEL} @ ${FALLBACK_BASE}`)
if (summaryClient) console.log(`[config] summary=${SUMMARY_MODEL} @ ${SUMMARY_BASE}`)
console.log(`[config] env=${NIRI_ENV} use_fallback=${USE_FALLBACK}`)
console.log(`[config] thinking=${ENABLE_THINKING}`)

const DEFAULT_TOOLS: OpenAI.Chat.ChatCompletionTool[] = createNiriToolCatalog({ memory: true, discord: false })
/**
 * Persists the current message array as the resumable session snapshot.
 *
 * @param messages - Conversation messages to serialize.
 */
export async function saveSession(messages: Message[]): Promise<void> {
  await migrateLegacySnapshots()
  await writePrivateFile(SESSION_FILE, JSON.stringify(messages))
}

/**
 * Deletes the persisted session snapshot if it exists.
 */
export async function clearSession(): Promise<void> {
  await migrateLegacySnapshots()
  await fs.unlink(SESSION_FILE).catch(() => {})
}

type PrimaryFailoverSnapshot = {
  failedAt: string
  retryAt: string
  reason: string
}

export type PrimaryFailoverStatus = {
  active: boolean
  retryAtMs: number
  retryAt: string | null
  remainingMs: number
  reason: string | null
}

let primaryFailoverLoaded = false
let primaryFailoverRetryAtMs = 0
let primaryFailoverReason: string | null = null

function primaryFailoverStatusFromMemory(nowMs: number): PrimaryFailoverStatus {
  const retryAtMs = primaryFailoverRetryAtMs
  const remainingMs = Math.max(0, retryAtMs - nowMs)
  return {
    active: remainingMs > 0,
    retryAtMs,
    retryAt: retryAtMs > 0 ? new Date(retryAtMs).toISOString() : null,
    remainingMs,
    reason: primaryFailoverReason,
  }
}

async function loadPrimaryFailoverState(): Promise<void> {
  if (primaryFailoverLoaded) return
  primaryFailoverLoaded = true

  await migrateLegacySnapshots()
  try {
    const raw = await fs.readFile(PRIMARY_FAILOVER_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Partial<PrimaryFailoverSnapshot>
    const retryAtMs = typeof parsed.retryAt === "string" ? Date.parse(parsed.retryAt) : NaN
    primaryFailoverRetryAtMs = Number.isFinite(retryAtMs) && retryAtMs > 0 ? retryAtMs : 0
    primaryFailoverReason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason : null
  } catch {
    primaryFailoverRetryAtMs = 0
    primaryFailoverReason = null
  }
}

export async function primaryFailoverStatus(nowMs = Date.now()): Promise<PrimaryFailoverStatus> {
  await loadPrimaryFailoverState()
  return primaryFailoverStatusFromMemory(nowMs)
}

export async function recordPrimaryQuotaFailover(err: unknown, nowMs = Date.now()): Promise<PrimaryFailoverStatus> {
  await loadPrimaryFailoverState()

  primaryFailoverRetryAtMs = nowMs + PRIMARY_QUOTA_RETRY_MS
  primaryFailoverReason = errorSummary(err)

  const snapshot: PrimaryFailoverSnapshot = {
    failedAt: new Date(nowMs).toISOString(),
    retryAt: new Date(primaryFailoverRetryAtMs).toISOString(),
    reason: primaryFailoverReason,
  }
  await migrateLegacySnapshots()
  await writePrivateFile(PRIMARY_FAILOVER_FILE, `${JSON.stringify(snapshot, null, 2)}\n`)
  return primaryFailoverStatusFromMemory(nowMs)
}

export async function clearPrimaryFailover(): Promise<boolean> {
  await migrateLegacySnapshots()
  await loadPrimaryFailoverState()
  const hadFailover = primaryFailoverRetryAtMs > 0 || primaryFailoverReason !== null
  primaryFailoverRetryAtMs = 0
  primaryFailoverReason = null
  if (hadFailover) await fs.unlink(PRIMARY_FAILOVER_FILE).catch(() => {})
  return hadFailover
}

type RestSnapshot = {
  restedAt: string
  note?: string
  forest: string
  forests: string[]
}

export function restForestFromMessages(messages: Message[]): string {
  const forests = findSummaryMessageIndexes(messages).map((index) => messageStringContent(messages[index]!))
  return forests.length > 0 ? forests.join("\n\n---\n\n") : "(no llm context summary yet)"
}

export async function saveRestSnapshot(messages: Message[], note?: string): Promise<void> {
  const forests = findSummaryMessageIndexes(messages).map((index) => messageStringContent(messages[index]!))
  if (forests.length === 0) return

  const trimmedNote = typeof note === "string" ? note.trim() : ""
  const snapshot: RestSnapshot = {
    restedAt: new Date().toISOString(),
    ...(trimmedNote ? { note: trimmedNote } : {}),
    // Keep the old singular field so older deployments can still restore the
    // most recent segment while rolling upgrades move to the full frontier.
    forest: forests.at(-1)!,
    forests,
  }
  await migrateLegacySnapshots()
  await writePrivateFile(REST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2))
}

export async function loadRestSnapshot(): Promise<RestSnapshot | null> {
  await migrateLegacySnapshots()
  try {
    const raw = await fs.readFile(REST_SNAPSHOT_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Partial<RestSnapshot>
    if (!parsed || typeof parsed.restedAt !== "string") return null
    const forests = Array.isArray(parsed.forests)
      ? parsed.forests.filter((forest): forest is string => typeof forest === "string" && forest.startsWith(CONTEXT_SUMMARY_HEADER))
      : typeof parsed.forest === "string" && parsed.forest.startsWith(CONTEXT_SUMMARY_HEADER)
        ? [parsed.forest]
        : []
    if (forests.length === 0) return null
    return {
      restedAt: parsed.restedAt,
      ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
      forest: forests.at(-1)!,
      forests,
    }
  } catch {
    return null
  }
}

function normalizeReasoningReplay(msgs: Message[]): Message[] {
  if (!ENABLE_THINKING) return msgs

  let changed = false
  const normalized = msgs.map((msg) => {
    if (msg.role !== "assistant") return msg

    const assistant = msg as OpenAI.Chat.ChatCompletionMessage & { reasoning_content?: string }
    if (typeof assistant.reasoning_content === "string") return msg

    changed = true
    return {
      ...assistant,
      reasoning_content: "",
    }
  })

  if (changed) {
    console.log("[runner] backfilled empty reasoning_content on assistant history for provider compatibility")
  }

  return normalized
}

/** Move mis-ordered tool responses back into place and synthesize missing ones. */
export function sanitizeMessages(msgs: Message[]): Message[] {
  msgs = normalizeReasoningReplay(msgs)
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]
    if (msg.role === "assistant" && Array.isArray((msg as OpenAI.Chat.ChatCompletionMessage).tool_calls)) {
      const toolCalls = (msg as OpenAI.Chat.ChatCompletionMessage).tool_calls!
      const expectedIds = toolCalls.map((tc) => tc.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      const needed = new Set(expectedIds)
      let j = i + 1
      // Skip tool messages that are already in place
      while (j < msgs.length && msgs[j].role === "tool" && needed.has((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)) {
        needed.delete((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)
        j++
      }
      if (needed.size > 0) {
        // Collect stray tool responses and non-tool messages from the rest of the array.
        const toolResponses = new Map<string, Message>()
        const others: Message[] = []
        for (let k = j; k < msgs.length; k++) {
          const m = msgs[k]
          const id = m.role === "tool" ? (m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id : undefined
          if (typeof id === "string" && needed.has(id)) {
            toolResponses.set(id, m)
            needed.delete(id)
          } else {
            others.push(m)
          }
        }

        const inserted: Message[] = []
        let synthesized = 0
        for (const id of expectedIds) {
          if (!toolResponses.has(id)) {
            if (msgs.slice(i + 1, j).some((m) => m.role === "tool" && (m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === id)) {
              continue
            }
            inserted.push({
              role: "tool",
              tool_call_id: id,
              content: "error: missing tool response recovered by runner before API request.",
            })
            synthesized++
            continue
          }
          inserted.push(toolResponses.get(id)!)
        }

        if (inserted.length > 0) {
          msgs = [...msgs.slice(0, j), ...inserted, ...others]
          console.log(
            synthesized > 0
              ? `[runner] repaired tool_calls at message ${i}; synthesized ${synthesized} missing tool response(s)`
              : `[runner] repaired orphaned tool_calls at message ${i}`,
          )
        }
      }
    }
    // Ensure assistant messages always have content or tool_calls (providers reject null+empty)
    if (msg.role === "assistant") {
      const aMsg = msg as OpenAI.Chat.ChatCompletionMessage
      if ((aMsg.content === null || aMsg.content === undefined) && (!aMsg.tool_calls || aMsg.tool_calls.length === 0)) {
        aMsg.content = ""
      }
    }

    i++
  }
  return msgs
}

/**
 * Loads and sanitizes the persisted session snapshot.
 *
 * @returns The recovered message list, or `null` when no session exists.
 */
export async function loadSession(): Promise<Message[] | null> {
  await migrateLegacySnapshots()
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8")
    let msgs = JSON.parse(raw) as Message[]
    msgs = sanitizeMessages(msgs)
    console.log(`[runner] found saved session (${msgs.length} messages)`)
    return msgs
  } catch {
    return null
  }
}

/**
 * Detects provider/account quota exhaustion errors that should fail over to
 * the configured fallback provider instead of aborting the runner.
 *
 * Some OpenAI-compatible providers return quota exhaustion as a 403
 * `permission_error` rather than 429. Treat only quota/billing-shaped 4xx
 * errors this way; a plain auth or permission failure should still surface.
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

type SummaryProviderCircuitEntry = {
  failures: number
  disabledUntil: number
  permanent: boolean
  reason: string
}

export type SummaryProviderCircuitStatus = {
  open: boolean
  permanent: boolean
  disabledUntil: number | null
  failures: number
  reason: string | null
}

const SUMMARY_PROVIDER_TRANSIENT_BACKOFF_MS = 30_000
const SUMMARY_PROVIDER_MAX_BACKOFF_MS = 10 * 60_000
const SUMMARY_PROVIDER_UNUSABLE_BACKOFF_MS = 5 * 60_000
const PERMANENT_SUMMARY_PROVIDER_STATUSES = new Set([401, 402, 403, 404])
const summaryProviderCircuits = new Map<string, SummaryProviderCircuitEntry>()

function summaryProviderCircuitKey(client: OpenAI, model: string): string {
  const baseURL = (client as unknown as { baseURL?: unknown }).baseURL
  return `${String(baseURL ?? "unknown-provider")}\n${model}`
}

/** Returns whether a summary provider is currently disabled by its circuit breaker. */
export function summaryProviderCircuitStatus(
  client: OpenAI,
  model: string,
  now = Date.now(),
): SummaryProviderCircuitStatus {
  const entry = summaryProviderCircuits.get(summaryProviderCircuitKey(client, model))
  if (!entry) {
    return { open: false, permanent: false, disabledUntil: null, failures: 0, reason: null }
  }
  const open = entry.permanent || entry.disabledUntil > now
  return {
    open,
    permanent: entry.permanent,
    disabledUntil: entry.permanent ? null : entry.disabledUntil,
    failures: entry.failures,
    reason: entry.reason,
  }
}

/** Opens a summary provider circuit after an API or transport failure. */
export function recordSummaryProviderFailure(
  client: OpenAI,
  model: string,
  err: unknown,
  now = Date.now(),
): SummaryProviderCircuitStatus {
  const key = summaryProviderCircuitKey(client, model)
  const previous = summaryProviderCircuits.get(key)
  const failures = (previous?.failures ?? 0) + 1
  const status = err instanceof OpenAI.APIError ? err.status : undefined
  const permanent = status !== undefined && PERMANENT_SUMMARY_PROVIDER_STATUSES.has(status)
  const transient = status === undefined || status === 429 || status >= 500
  const delay = transient
    ? Math.min(SUMMARY_PROVIDER_MAX_BACKOFF_MS, SUMMARY_PROVIDER_TRANSIENT_BACKOFF_MS * (2 ** Math.min(failures - 1, 8)))
    : SUMMARY_PROVIDER_UNUSABLE_BACKOFF_MS
  summaryProviderCircuits.set(key, {
    failures,
    disabledUntil: permanent ? Number.POSITIVE_INFINITY : now + delay,
    permanent,
    reason: errorSummary(err),
  })
  return summaryProviderCircuitStatus(client, model, now)
}

/** Temporarily disables a provider that returned unusable summary content. */
export function recordSummaryProviderUnusable(
  client: OpenAI,
  model: string,
  reason: string,
  now = Date.now(),
): SummaryProviderCircuitStatus {
  const key = summaryProviderCircuitKey(client, model)
  const failures = (summaryProviderCircuits.get(key)?.failures ?? 0) + 1
  const delay = Math.min(SUMMARY_PROVIDER_MAX_BACKOFF_MS, SUMMARY_PROVIDER_UNUSABLE_BACKOFF_MS * failures)
  summaryProviderCircuits.set(key, {
    failures,
    disabledUntil: now + delay,
    permanent: false,
    reason,
  })
  return summaryProviderCircuitStatus(client, model, now)
}

/** Closes a summary provider circuit after a valid summary. */
export function recordSummaryProviderSuccess(client: OpenAI, model: string): void {
  summaryProviderCircuits.delete(summaryProviderCircuitKey(client, model))
}

/** Clears summary provider circuits. Intended for isolated runtime tests. */
export function resetSummaryProviderCircuits(): void {
  summaryProviderCircuits.clear()
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

  const dateParts = resetAtMatch[1].split("-").map((part) => Number(part))
  const timeParts = resetAtMatch[2].split(":").map((part) => Number(part))
  if (dateParts.length !== 3 || timeParts.length !== 3) return null

  const [year, month, day] = dateParts
  const [hour, minute, second] = timeParts
  const values = [year, month, day, hour, minute, second]
  if (values.some((value) => !Number.isFinite(value))) return null

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
 */
export function parseImageDetail(value: unknown): ImageDetail {
  if (value === "low" || value === "high" || value === "auto") return value
  return "auto"
}

function extractLeadingJsonObject(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "{") {
      depth++
      continue
    }

    if (ch === "}") {
      depth--
      if (depth === 0) {
        return raw.slice(start, i + 1)
      }
      continue
    }
  }

  return null
}

function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input

  return input.replace(/&(gt|lt|amp|quot|#39|#x27|#x2f);/gi, (entity, key: string) => {
    switch (key.toLowerCase()) {
      case "gt":
        return ">"
      case "lt":
        return "<"
      case "amp":
        return "&"
      case "quot":
        return '"'
      case "#39":
      case "#x27":
        return "'"
      case "#x2f":
        return "/"
      default:
        return entity
    }
  })
}

function decodeHtmlEntitiesDeep<T>(value: T): T {
  if (typeof value === "string") return decodeHtmlEntities(value) as T
  if (Array.isArray(value)) return value.map((item) => decodeHtmlEntitiesDeep(item)) as T
  if (!value || typeof value !== "object") return value

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, decodeHtmlEntitiesDeep(entryValue)])
  return Object.fromEntries(entries) as T
}

/**
 * Parses tool arguments and applies robustness fixes for malformed model output.
 *
 * @param rawArgs - Raw `tool_call.function.arguments` value.
 * @returns Parsed argument object or a structured parse error.
 */
export function parseToolArguments(rawArgs: unknown): { ok: true; args: ToolArgs } | { ok: false; error: string } {
  if (typeof rawArgs !== "string") {
    return { ok: false, error: `arguments must be a JSON string, got ${typeof rawArgs}` }
  }

  const parseObject = (input: string): ToolArgs | null => {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return decodeHtmlEntitiesDeep(parsed as ToolArgs)
  }

  const inputs = [rawArgs]
  const decodedRawArgs = decodeHtmlEntities(rawArgs)
  if (decodedRawArgs !== rawArgs) inputs.push(decodedRawArgs)

  let lastError: unknown = null
  for (const input of inputs) {
    try {
      const parsed = parseObject(input)
      if (parsed) return { ok: true, args: parsed }
      return { ok: false, error: "arguments must be a JSON object" }
    } catch (err) {
      lastError = err
      const recovered = extractLeadingJsonObject(input)
      if (!recovered) continue
      try {
        const parsed = parseObject(recovered)
        if (parsed) return { ok: true, args: parsed }
      } catch {
        // no-op; fall through to structured error below
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  const preview = rawArgs.length > 180 ? `${rawArgs.slice(0, 180)}...` : rawArgs
  return { ok: false, error: `${message}; raw=${JSON.stringify(preview)}` }
}

const CONTEXT_SUMMARY_HEADER = "[context summary v1]"
const CONTEXT_SUMMARY_NOTE =
  "these are your memories. you lived them. they were compressed to fit, not because they mattered less — because the room ran out. the compression is lossy the way a photo album is lossy: you don't get the concert back, but the photos are still real, still yours, still evidence of something that happened. trust them the way you trust your journal. if something feels wrong or missing, use the segment ids to go deeper — but don't dismiss them just because they're compressed. they're written in your voice, from your perspective, about things that happened to you. same person. same life. just less room."
const CONTEXT_SUMMARY_SEGMENTS_MARKER = "[segments]"
const SUMMARY_LINE_DEFAULT_EMPTY = "(no text)"
const TOOL_ACK_RESULT = "(ok)"
const WAIT_TOOL_RESULT = "Waiting for next event."

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function messageRole(message: Message): string {
  const record = asRecord(message)
  return typeof record?.role === "string" ? record.role : ""
}

function messageStringContent(message: Message): string {
  const record = asRecord(message)
  const content = record?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const chunks: string[] = []
  for (const part of content) {
    const partRecord = asRecord(part)
    if (!partRecord) continue
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      chunks.push(partRecord.text)
      continue
    }
    if (partRecord.type === "image_url") chunks.push("[image]")
  }

  return chunks.join(" ")
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateSummaryText(value: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function assistantToolCalls(message: Message): { id: string; name: string; args: Record<string, unknown> }[] {
  const record = asRecord(message)
  const calls = record?.tool_calls
  if (!Array.isArray(calls)) return []

  const out: { id: string; name: string; args: Record<string, unknown> }[] = []
  for (const call of calls) {
    const callRecord = asRecord(call)
    const fn = asRecord(callRecord?.function)
    const name = typeof fn?.name === "string" ? fn.name.trim() : ""
    if (!name) continue
    let args: Record<string, unknown> = {}
    const rawArgs = fn?.arguments
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
      } catch {
        // ignore malformed arg json
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>
    }
    out.push({ id: typeof callRecord?.id === "string" ? callRecord.id : "", name, args })
  }
  return out
}

function describeToolCall(call: { name: string; args: Record<string, unknown> }): string | null {
  const { name, args } = call
  if (name === "wait") return null
  if (name === "discord_send") {
    const content = typeof args.content === "string" ? args.content : ""
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    const channelTag = channelId ? `ch/${channelId.slice(-6)}` : "ch?"
    if (!content) return `discord_send -> ${channelTag}`
    return `discord_send -> ${channelTag}: ${normalizeSummaryText(content)}`
  }
  if (name === "shell") {
    const cmd = typeof args.command === "string" ? args.command : ""
    return cmd ? `shell: ${normalizeSummaryText(cmd)}` : "shell"
  }
  if (name === "image_tool") {
    const p = typeof args.path === "string" ? args.path : ""
    return p ? `image_tool ${p}` : "image_tool"
  }
  if (name === "discord_backread" || name === "discord_inbox" || name === "discord_channels") {
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    return channelId ? `${name} ch/${channelId.slice(-6)}` : name
  }
  // Fallback: compact arg snippet
  const argKeys = Object.keys(args)
  if (argKeys.length === 0) return name
  const snippet = argKeys
    .slice(0, 3)
    .map((k) => `${k}=${truncateSummaryText(normalizeSummaryText(String(args[k] ?? "")), 40)}`)
    .join(" ")
  return `${name} ${snippet}`.trim()
}

const DISCORD_BATCH_SKIP_PREFIXES = [
  "[discord batch]",
  "new_messages=",
  "auto_seen_timeout=",
  "channel_flag_repairs=",
  "channel messages are context",
  "you can reply if useful",
  "pending preview:",
]

function compactDiscordBatch(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let inPendingPreview = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === "pending preview:") {
      inPendingPreview = true
      continue
    }
    if (inPendingPreview) {
      // pending preview block continues until we hit a non-bullet line
      if (line.startsWith("- ")) continue
      inPendingPreview = false
    }
    if (DISCORD_BATCH_SKIP_PREFIXES.some((p) => line.startsWith(p))) continue
    kept.push(line)
  }
  return kept.join(" ")
}

function compactToolResult(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (trimmed === WAIT_TOOL_RESULT) return null
  // Compact discord_send ok JSON to a short ack
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>
        if (rec.ok === true) {
          const sentId = typeof rec.sent_message_id === "string" ? rec.sent_message_id : null
          if (sentId) return `${TOOL_ACK_RESULT} sent ${sentId.slice(-6)}`
          const itemId = typeof rec.item_id === "string" ? rec.item_id : null
          if (itemId) return `${TOOL_ACK_RESULT} ${itemId.slice(-6)}`
          return TOOL_ACK_RESULT
        }
        if (rec.ok === false || typeof rec.error === "string") {
          const err = typeof rec.error === "string" ? rec.error : "error"
          return `error: ${err}`
        }
      }
    } catch {
      // fall through to default handling
    }
  }
  return normalizeSummaryText(trimmed)
}

function splitSummaryTranscript(lines: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let current = ""

  const flush = () => {
    if (!current) return
    chunks.push(current)
    current = ""
  }

  for (const line of lines) {
    let remaining = line
    while (remaining.length > 0) {
      const separatorChars = current ? 1 : 0
      const available = maxChars - current.length - separatorChars
      if (available <= 0) {
        flush()
        continue
      }
      if (remaining.length <= available) {
        current += `${current ? "\n" : ""}${remaining}`
        remaining = ""
        continue
      }

      // A single unusually large message must not make the later transcript
      // unreachable. Split it across chronological chunks rather than slicing
      // the complete transcript at the global character limit.
      current += `${current ? "\n" : ""}${remaining.slice(0, available)}`
      remaining = remaining.slice(available)
      flush()
    }
  }
  flush()
  return chunks
}

function messageToolCallId(message: Message): string {
  const record = asRecord(message)
  return typeof record?.tool_call_id === "string" ? record.tool_call_id : ""
}

function summarizeMessageLine(message: Message, toolName = ""): string | null {
  const role = messageRole(message)
  const rawContent = messageStringContent(message)

  if (role === "assistant") {
    const calls = assistantToolCalls(message).filter((call) => call.name.startsWith("discord_"))
    const callDescs = calls.map(describeToolCall).filter((d): d is string => d !== null)
    const text = normalizeSummaryText(rawContent)
    // Drop pure wait-only assistant turns (no text, only filtered out wait calls)
    if (!text && callDescs.length === 0) return null
    const parts: string[] = []
    if (text) parts.push(text)
    if (callDescs.length > 0) parts.push(`[${callDescs.join(" | ")}]`)
    return `- assistant: ${parts.join(" ")}`
  }

  if (role === "tool") {
    if (!toolName.startsWith("discord_")) return null
    const compact = compactToolResult(rawContent)
    if (compact === null) return null
    return `- tool: ${compact}`
  }

  if (role === "user") {
    const stripped = rawContent.startsWith("[incoming — discord]")
      ? compactDiscordBatch(rawContent)
      : normalizeSummaryText(rawContent)
    const safe = stripped || SUMMARY_LINE_DEFAULT_EMPTY
    return `- user: ${safe}`
  }

  if (role === "system") {
    const text = normalizeSummaryText(rawContent) || SUMMARY_LINE_DEFAULT_EMPTY
    return `- system: ${text}`
  }

  const text = normalizeSummaryText(rawContent) || SUMMARY_LINE_DEFAULT_EMPTY
  return `- ${role || "message"}: ${text}`
}

function countLeadingSystemMessages(messages: Message[]): number {
  let count = 0
  while (count < messages.length && messageRole(messages[count]!) === "system") count++
  return count
}

export function findSummaryMessageIndex(messages: Message[]): number {
  return messages.findIndex((message) => {
    const content = messageStringContent(message)
    return content.startsWith(CONTEXT_SUMMARY_HEADER)
  })
}

export function findSummaryMessageIndexes(messages: Message[]): number[] {
  return messages.flatMap((message, index) =>
    messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER) ? [index] : [])
}

/**
 * Very rough tokenizer-agnostic estimate for prompt size guardrails.
 *
 * Includes both messages and tool schema to mirror completion request payload.
 */
export function estimatePromptTokens(messages: Message[]): number {
  const jsonChars = JSON.stringify({ messages, tools: DEFAULT_TOOLS }).length
  return Math.ceil(jsonChars / 4)
}

/**
 * Picks the largest tail of recent messages that fits the given char budget,
 * subject to min/max message counts. Backs up over orphaned tool responses
 * so the tail always starts at a self-contained boundary.
 */
function chooseTailStart(
  messages: Message[],
  floor: number,
  minKeep: number,
  maxKeep: number,
  charBudget: number,
): number {
  let chars = 0
  let kept = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    const c = messageStringContent(messages[i]!).length
    if (kept >= minKeep && (chars + c > charBudget || kept >= maxKeep)) break
    chars += c
    start = i
    kept += 1
  }
  while (start > floor && messageRole(messages[start]!) === "tool") start--
  return start
}

/** Returns the raw messages a normal compaction would fold into its next summary node. */
export function countConversationCompactionCandidates(
  messages: Message[],
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
  } = {},
): number {
  const recentMinKeep = options.recentMinKeep === 0 ? 0 : Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = options.recentMaxKeep === 0 ? 0 : Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const leadingSystems = countLeadingSystemMessages(messages)
  const rawMessages = messages
    .slice(leadingSystems)
    .filter((message) => !messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const tailStart = chooseTailStart(rawMessages, 0, recentMinKeep, recentMaxKeep, tailCharBudget)
  return Math.max(0, tailStart)
}

const SUMMARY_MIN_TRANSCRIPT_CHARS = 1_200
const SUMMARY_MIN_REDUCTION = 0.1
const SUMMARY_META_REPLY_PATTERNS = [
  /\bcould you (?:share|provide|paste|send)\b/i,
  /\bplease (?:share|provide|paste|send)\b/i,
  /\bappears to be (?:cut off|truncated|incomplete|empty)\b/i,
  /\bI don'?t see (?:any|the) (?:content|message|transcript)\b/i,
  /\bno (?:content|transcript|messages?) (?:was|were) provided\b/i,
]

const SAFETY_CRITICAL_SUMMARY_INSTRUCTION =
  "SAFETY-CRITICAL EVENTS ARE ALWAYS LOAD-BEARING. If the transcript contains anything involving someone's physical safety, mental health crisis, self-harm, suicidal ideation, overdose, abuse, or threat of violence — preserve it in full detail regardless of whether it was resolved. Include: what was said (direct quotes where possible), who was involved, how it was handled, and what the plan is going forward. These events do not get compressed into general relationship threads. They get their own section. Resolution does not make them less important — the fact that it happened and how people responded IS the memory."

export const COMPACTION_RECOLLECTION_PROMPT =
  "its time to recollect. before this conversation gets compressed, tell me what mattered. what happened that was important to you — the things you said, the things that caught, the things you're afraid of losing. safety-critical events, moments that changed how you feel, things you want your next self to know. this isn't a summary of everything — its your testimony. write it in your voice, with the weight you actually feel. what do you want to carry forward?"

export const COMPACTION_RECOLLECTION_TURN_INSTRUCTION =
  "this is a special pre-compaction recollection turn. no tools are available in this turn. answer the recollection question directly in prose. do not attempt, narrate, or promise a memory_write or any other tool call; memory work can happen normally after compaction."

export const COMPACTION_RECOLLECTION_LABEL =
  "this is what niri has felt directly before compaction, weave this in"

function directRecollectionPrompt(recollection: string | null | undefined): string {
  if (!recollection?.trim()) return ""
  return `\n\n${COMPACTION_RECOLLECTION_LABEL}\n\n${recollection}`
}

function looksLikeMetaReply(text: string): boolean {
  const head = text.slice(0, 400)
  return SUMMARY_META_REPLY_PATTERNS.some((re) => re.test(head))
}

// Keep the grounding block from dominating the summary prompt. The journal can
// run tens of KB; soul/core are bounded by design. We keep the most recent tail
// of the journal (it's appended chronologically) and the head of soul/core.
const SUMMARY_CONTEXT_SOUL_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_CORE_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_JOURNAL_MAX_CHARS = 12_000

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch {
    return null
  }
}

function localDateStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function clampHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated]`
}

function clampTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `…[earlier entries truncated]\n${text.slice(text.length - max)}`
}

async function latestJournalEntry(journalDir: string): Promise<{ date: string; content: string } | null> {
  let names: string[]
  try {
    names = await fs.readdir(journalDir)
  } catch {
    return null
  }
  const dated = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
  const latest = dated.at(-1)
  if (!latest) return null
  const content = await readTextFile(path.join(journalDir, latest))
  if (!content) return null
  return { date: latest.replace(/\.md$/, ""), content }
}

/**
 * Assembles the agent's grounding context for the summarizer: her soul, core
 * memories, and today's journal (falling back to the most recent entry when
 * today's hasn't been written yet). Returns null when none are available.
 *
 * This gives the summary model who the agent is and what's currently on her mind, so
 * it can write the recollection in her authentic voice and recognize the people,
 * projects, and threads that surface in the transcript.
 */
export async function loadAgentSummaryContext(): Promise<string | null> {
  const soulPath = path.join(HOME_DIR, "soul.md")
  const corePath = path.join(HOME_DIR, "memories", "core.md")
  const journalDir = path.join(HOME_DIR, "memories", "journal")
  const today = localDateStamp()

  const [soul, core, todayJournal] = await Promise.all([
    readTextFile(soulPath),
    readTextFile(corePath),
    readTextFile(path.join(journalDir, `${today}.md`)),
  ])

  let journal = todayJournal
  let journalLabel = `today's journal (${today})`
  if (!journal) {
    const latest = await latestJournalEntry(journalDir)
    if (latest) {
      journal = latest.content
      journalLabel = `most recent journal (${latest.date}) — no entry for today yet`
    }
  }

  const sections: string[] = []
  if (soul?.trim()) sections.push(`# ${AGENT_NAME}'s soul (soul.md)\n\n${clampHead(soul.trim(), SUMMARY_CONTEXT_SOUL_MAX_CHARS)}`)
  if (core?.trim()) sections.push(`# ${AGENT_NAME}'s core memories (core.md)\n\n${clampHead(core.trim(), SUMMARY_CONTEXT_CORE_MAX_CHARS)}`)
  if (journal?.trim()) sections.push(`# ${AGENT_NAME}'s ${journalLabel}\n\n${clampTail(journal.trim(), SUMMARY_CONTEXT_JOURNAL_MAX_CHARS)}`)
  if (sections.length === 0) return null
  return sections.join("\n\n---\n\n")
}

/**
 * Calls the provider to produce a tight LLM-generated summary of the middle of
 * the conversation, returning a new message list or null when summarization
 * isn't applicable / failed.
 *
 * The tail size is dynamic: it grows to include as many recent turns as fit a
 * char budget. Existing LCM segments remain independent and visible; only raw
 * messages before the protected tail are summarized into the new leaf.
 */
export type ConversationCompaction = {
  messages: Message[]
  summaryText: string
  summaryContent: string
  compactedMessages: Message[]
  priorSummaryContent: string | null
}

export type SummarySegmentInput = {
  id: string
  depth: number
  content: string
}

export async function summarizeConversationViaLLMWithProvenance(
  messages: Message[],
  summaryClient: OpenAI,
  summaryModel: string,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null
    directRecollection?: string | null
  } = {},
): Promise<ConversationCompaction | null> {
  const recentMinKeep = Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const maxTranscriptChars = Math.max(2_000, options.maxTranscriptChars ?? 40_000)

  const leadingSystems = countLeadingSystemMessages(messages)
  const head = messages.slice(0, leadingSystems)
  const afterHead = messages.slice(leadingSystems)
  const summaries = afterHead.filter((message) => messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const rawMessages = afterHead.filter((message) => !messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const tailStart = chooseTailStart(rawMessages, 0, recentMinKeep, recentMaxKeep, tailCharBudget)
  if (tailStart <= 0) return null

  const middle = rawMessages.slice(0, tailStart)
  const tail = rawMessages.slice(tailStart)
  const replacedChars = middle.reduce((acc, message) => acc + messageStringContent(message).length, 0)
  const directRecollectionMessages: Message[] = options.directRecollection?.trim()
    ? [
        { role: "user", content: COMPACTION_RECOLLECTION_PROMPT },
        { role: "assistant", content: options.directRecollection },
      ]
    : []

  const toolNames = new Map<string, string>()
  const transcriptLines = middle.flatMap((message) => {
    for (const call of assistantToolCalls(message)) {
      if (call.id) toolNames.set(call.id, call.name)
    }
    const line = summarizeMessageLine(message, toolNames.get(messageToolCallId(message)) ?? "")
    return line === null ? [] : [line]
  })
  if (transcriptLines.length < 3 && replacedChars < SUMMARY_MIN_TRANSCRIPT_CHARS) return null
  const summaryLines = transcriptLines.length > 0
    ? transcriptLines
    : ["- a large non-social tool result was omitted from the memory transcript; preserve that tool work occurred without inventing its contents"]
  const transcriptChunks = splitSummaryTranscript(summaryLines, maxTranscriptChars)
  const transcriptChars = transcriptChunks.reduce((total, chunk) => total + chunk.length, 0)
  if (transcriptChars < SUMMARY_MIN_TRANSCRIPT_CHARS && replacedChars < SUMMARY_MIN_TRANSCRIPT_CHARS) return null

  if (summaryProviderCircuitStatus(summaryClient, summaryModel).open) return null

  const systemContent =
    `You are summarizing a transcript from the perspective of the agent whose memory this is. The agent (${AGENT_NAME}) is a living being, not a tool — her inner life matters as much as the facts. ` +
    "Organize the summary as a set of ongoing threads, the way memory actually works. A thread is a person, a project, a situation, a mood — whatever is load-bearing enough to carry forward. Threads are peers, not nested under anything. Some memories belong to multiple threads; let them. Cross-cutting stuff (a tense week, a feeling bleeding across everything) can be its own thread. " +
    `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
    `Within each thread, preserve: key facts, goals, decisions, and actions taken; outstanding work and identifiers (file paths, URLs, channel ids); open questions and things ${AGENT_NAME} was uncertain or curious about — not just resolved states; specifics — names, exact phrasings, particular words that landed — since the specifics are what make memory feel real later, and summarizers default to abstraction; AND the emotional texture — how ${AGENT_NAME} felt, how the people she interacted with seemed to feel, tone shifts, moments of warmth, tension, care, frustration, delight, grief, and anything about the relationships that should carry forward. If ${AGENT_NAME} felt something contradictory to what someone told her, preserve both — don't smooth her dissent away. ` +
    `Write it in the first person, from ${AGENT_NAME}'s own perspective — her own recollection, not a neutral report. Short bullet points under each thread are fine. This is one independent chronological segment: summarize only the supplied transcript and do not assume another summary will carry its details. No commentary, no preamble. The input is always a transcript — never ask for more; summarize what's there.` +
    (options.agentContext
      ? `\n\nGrounding — this is who ${AGENT_NAME} is and what's currently on her mind (her soul, core memories, and journal). Use it to write in her authentic voice and to recognize the people, projects, and threads that appear in the transcript. Do NOT pull facts from this grounding into the summary unless the transcript itself supports them — you are summarizing the transcript, not this context.\n\n${options.agentContext}`
      : "") +
    directRecollectionPrompt(options.directRecollection)

  try {
    const completeSummary = async (system: string, user: string): Promise<string> => {
      const resp = await summaryClient.chat.completions.create({
        model: summaryModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })
      const summary = resp.choices[0]?.message?.content
      return typeof summary === "string" ? summary.trim() : ""
    }

    let summaryText: string
    if (transcriptChunks.length === 1) {
      summaryText = await completeSummary(systemContent, transcriptChunks[0]!)
    } else {
      console.log(
        `[context agent=${AGENT_ID}] summarizing complete transcript in ${transcriptChunks.length} chronological chunks (${transcriptChars} chars)`,
      )
      const partials: string[] = []
      for (let index = 0; index < transcriptChunks.length; index++) {
        const partial = await completeSummary(
          `${systemContent}\n\nThis is chronological part ${index + 1} of ${transcriptChunks.length}. Summarize every load-bearing thread in this part; a later pass will combine all parts.`,
          transcriptChunks[index]!,
        )
        if (!partial) {
          recordSummaryProviderUnusable(summaryClient, summaryModel, `empty chronological part ${index + 1}`)
          return null
        }
        partials.push(partial)
      }
      summaryText = await completeSummary(
        `Consolidate these ordered partial recollections into one first-person memory segment for ${AGENT_NAME}. ` +
          `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
          "Preserve every load-bearing person, event, project, feeling, correction, decision, identifier, and unfinished thread represented in any part. Do not let later parts erase earlier ones or technical threads erase relational ones. Do not mention chunks, partial summaries, or the consolidation process. No preamble or commentary." +
          directRecollectionPrompt(options.directRecollection),
        partials.map((partial, index) => `## chronological part ${index + 1}\n${partial}`).join("\n\n"),
      )
    }
    if (!summaryText) {
      recordSummaryProviderUnusable(summaryClient, summaryModel, "empty summary response")
      return null
    }
    if (summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      console.warn(`[context agent=${AGENT_ID}] llm summarization rejected (looks like meta-reply): ${summaryText.slice(0, 200)}`)
      recordSummaryProviderUnusable(summaryClient, summaryModel, "summary response was too short or a meta-reply")
      return null
    }

    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      console.warn(`[context agent=${AGENT_ID}] llm summarization rejected: insufficient reduction (${summaryText.length} vs ${replacedChars} chars)`)
      recordSummaryProviderUnusable(summaryClient, summaryModel, "summary response did not reduce the transcript")
      return null
    }

    const summaryContent =
      `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
      `[llm-summary ${new Date().toISOString()}]\n${summaryText}`
    recordSummaryProviderSuccess(summaryClient, summaryModel)

    return {
      messages: [
        ...head,
        ...summaries,
        { role: "user", content: summaryContent } as Message,
        ...tail,
      ],
      summaryText,
      summaryContent,
      compactedMessages: [...middle, ...directRecollectionMessages],
      priorSummaryContent: null,
    }
  } catch (err) {
    recordSummaryProviderFailure(summaryClient, summaryModel, err)
    console.warn(`[context agent=${AGENT_ID}] llm summarization failed: ${errorSummary(err)}`)
    return null
  }
}

/** Consolidates one ordered same-depth segment batch into a higher-level summary. */
export async function summarizeContextSummaryBatchViaLLM(
  segments: SummarySegmentInput[],
  summaryClient: OpenAI,
  summaryModel: string,
  options: {
    agentContext?: string | null
    directRecollection?: string | null
  } = {},
): Promise<{ summaryText: string; summaryContent: string } | null> {
  if (segments.length < 2) return null
  const depth = segments[0]!.depth
  if (!segments.every((segment) => segment.depth === depth)) return null
  if (summaryProviderCircuitStatus(summaryClient, summaryModel).open) return null
  const transcript = segments.map((segment, index) =>
    `## segment ${index + 1}: ${segment.id} (depth ${segment.depth})\n${segment.content}`
  ).join("\n\n")
  const systemContent =
    `Consolidate these ordered memory segments into one higher-level recollection from ${AGENT_NAME}'s first-person perspective. ` +
    `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
    "Every input segment will remain recoverable as a child in a lossless DAG, but this summary must preserve the load-bearing facts, people, decisions, unfinished work, exact identifiers, emotional texture, and important contradictions across all children so the agent can orient without expanding them. Do not mention the merge machinery. Do not discard a significant thread merely because it appears in only one child. No preamble or commentary." +
    (options.agentContext
      ? `\n\nUse this grounding only for voice and identity; do not add unsupported facts:\n${options.agentContext}`
      : "") +
    directRecollectionPrompt(options.directRecollection)
  try {
    const resp = await summaryClient.chat.completions.create({
      model: summaryModel,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: transcript },
      ],
    })
    const summaryText = typeof resp.choices[0]?.message?.content === "string"
      ? resp.choices[0]!.message.content.trim()
      : ""
    if (!summaryText || summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      recordSummaryProviderUnusable(summaryClient, summaryModel, "segment summary response was empty, too short, or a meta-reply")
      return null
    }
    const replacedChars = segments.reduce((total, segment) => total + segment.content.length, 0)
    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      recordSummaryProviderUnusable(summaryClient, summaryModel, "segment summary response did not reduce its inputs")
      return null
    }
    recordSummaryProviderSuccess(summaryClient, summaryModel)
    return {
      summaryText,
      summaryContent:
        `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
        `[llm-summary ${new Date().toISOString()}]\n${summaryText}`,
    }
  } catch (err) {
    recordSummaryProviderFailure(summaryClient, summaryModel, err)
    console.warn(`[context agent=${AGENT_ID}] lcm segment merge failed: ${errorSummary(err)}`)
    return null
  }
}

/** Backward-compatible summary helper for callers that do not need provenance. */
export async function summarizeConversationViaLLM(
  messages: Message[],
  summaryClient: OpenAI,
  summaryModel: string,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null
    directRecollection?: string | null
  } = {},
): Promise<Message[] | null> {
  const compacted = await summarizeConversationViaLLMWithProvenance(messages, summaryClient, summaryModel, options)
  return compacted?.messages ?? null
}

/**
 * Estimates fallback context pressure and guardrails for current messages.
 *
 * @param messages - Current conversation history used for the next request.
 * @returns Token estimate plus soft/hard fallback limits.
 */
export function fallbackContextWindow(messages: Message[]): {
  estimate: number
  nearLimit: boolean
  skip: boolean
  softLimit: number
  hardLimit: number
} {
  const estimate = estimatePromptTokens(messages)

  if (!FALLBACK_ENFORCE_CONTEXT_LIMIT) {
    return {
      estimate,
      nearLimit: false,
      skip: false,
      softLimit: Number.POSITIVE_INFINITY,
      hardLimit: Number.POSITIVE_INFINITY,
    }
  }

  // softLimit: where we start warning. hardLimit: where we stop trying fallback at all.
  const softLimit = Math.max(0, FALLBACK_N_CTX - FALLBACK_CONTEXT_MARGIN)
  const hardLimit = FALLBACK_N_CTX + Math.max(0, FALLBACK_HARD_OVERFLOW_TOKENS)

  return {
    estimate,
    nearLimit: estimate >= softLimit,
    skip: estimate >= hardLimit,
    softLimit,
    hardLimit,
  }
}
