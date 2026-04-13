import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import OpenAI from "openai"
import { imageRootForModelInput } from "../container/index.js"
import type { Message } from "../types.js"
import type { ImageDetail, ToolArgs } from "./types.js"

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..")
const SESSION_FILE = path.join(PROJECT_ROOT, "session.json")

export const TOKEN_NUDGE_THRESHOLD = parseInt(process.env.TOKEN_NUDGE_THRESHOLD ?? "120000")
export const FALLBACK_TOKEN_NUDGE_THRESHOLD = parseInt(process.env.FALLBACK_TOKEN_NUDGE_THRESHOLD ?? "50000")
export const CONTEXT_COMPACT_TARGET_TOKENS = parseInt(process.env.CONTEXT_COMPACT_TARGET_TOKENS ?? "65000")
export const CONTEXT_COMPACT_TRIGGER_TOKENS = parseInt(process.env.CONTEXT_COMPACT_TRIGGER_TOKENS ?? "90000")
export const CONTEXT_COMPACT_RECENT_MESSAGES = parseInt(process.env.CONTEXT_COMPACT_RECENT_MESSAGES ?? "80")
export const CONTEXT_COMPACT_CHUNK_MESSAGES = parseInt(process.env.CONTEXT_COMPACT_CHUNK_MESSAGES ?? "32")
export const CONTEXT_COMPACT_SUMMARY_MAX_CHARS = parseInt(process.env.CONTEXT_COMPACT_SUMMARY_MAX_CHARS ?? "16000")

const NIRI_ENV = (process.env.NIRI_ENV ?? "default").trim().toLowerCase()
export const USE_FALLBACK = NIRI_ENV === "local"

export const API_BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
export const MODEL = process.env.MODEL ?? ""
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
export const FALLBACK_TOOL_CHOICE = parseToolChoiceEnv(process.env.FALLBACK_TOOL_CHOICE, "required")
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
const fallbackHeaders: Record<string, string> = {}
if (process.env.FALLBACK_OPENAI_REFERER) fallbackHeaders["HTTP-Referer"] = process.env.FALLBACK_OPENAI_REFERER
if (process.env.FALLBACK_OPENAI_TITLE) fallbackHeaders["X-Title"] = process.env.FALLBACK_OPENAI_TITLE

if (!USE_FALLBACK && !MODEL) {
  throw new Error("MODEL is required unless fallback is forced (NIRI_ENV=local).")
}

if (!USE_FALLBACK && !process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required unless fallback is forced (NIRI_ENV=local).")
}

if (USE_FALLBACK && !fallbackApiKey) {
  throw new Error(
    "Fallback API key is required in local mode. Set FALLBACK_OPENAI_API_KEY (or OPENROUTER_API_KEY / LMSTUDIO_API_KEY).",
  )
}

export const client = USE_FALLBACK
  ? null
  : new OpenAI({
      baseURL: API_BASE,
      apiKey: process.env.OPENAI_API_KEY!,
    })

export const fallbackClient = new OpenAI({
  baseURL: FALLBACK_BASE,
  apiKey: fallbackApiKey || "lm-studio", // Keep LM Studio default when running against localhost.
  defaultHeaders: Object.keys(fallbackHeaders).length ? fallbackHeaders : undefined,
})

console.log(`[config] primary=${MODEL} @ ${API_BASE}`)
console.log(`[config] fallback=${FALLBACK_MODEL} @ ${FALLBACK_BASE}`)
console.log(`[config] env=${NIRI_ENV} use_fallback=${USE_FALLBACK}`)

const IMAGE_ROOT_HINT = imageRootForModelInput()

export const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a bash command in your Linux environment. Stateful — cd, env vars, etc. persist. Output is automatically capped (default 150 lines, 40 for known-verbose commands like apt/pip/npm). Pass max_lines to override; use 0 for unlimited. You can also pass timeout_ms (default 30000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          max_lines: {
            type: "integer",
            description:
              "Maximum lines to return. Defaults to 150 (40 for verbose commands like apt/pip). Use 0 for unlimited.",
          },
          timeout_ms: {
            type: "integer",
            description: "Execution timeout in milliseconds. Defaults to 30000. Max 600000.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from your Linux environment with optional line-range selection. More token-efficient than shell+cat for large files. Returns content with a header showing the line range and total line count. Supports timeout_ms (default 120000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          start_line: {
            type: "integer",
            description: "First line to read (1-indexed). Defaults to 1.",
          },
          end_line: {
            type: "integer",
            description: "Last line to read (inclusive). Defaults to start_line + 99.",
          },
          timeout_ms: {
            type: "integer",
            description: "Read timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact snippet of text. old_text must match exactly once in the file — precise, safe, and no shell-escaping headaches. Use read_file first if you need to confirm the exact text. Supports timeout_ms (default 120000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          old_text: {
            type: "string",
            description: "The exact text to find and replace. Must appear exactly once in the file.",
          },
          new_text: {
            type: "string",
            description: "Replacement text. May be empty to delete old_text.",
          },
          timeout_ms: {
            type: "integer",
            description: "Edit timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_tool",
      description:
        `Attach an image from ${IMAGE_ROOT_HINT} so it is injected as a multimodal user message on the next model turn. Use this after creating/downloading an image with shell.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Absolute image path inside ${IMAGE_ROOT_HINT} (for example ${IMAGE_ROOT_HINT}/screenshot.png).`,
          },
          note: {
            type: "string",
            description: "Optional text instruction to accompany the image for the next turn.",
          },
          detail: {
            type: "string",
            enum: ["auto", "low", "high"],
            description: "Vision detail level for the next turn image input.",
          },
          timeout_ms: {
            type: "integer",
            description: "Read timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_scan",
      description:
        "Scan configured Discord channels and ingest messages into the local Discord inbox database. Uses DISCORD_SCAN_CHANNEL_IDS by default; pass channel_ids to override.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Per-channel message fetch limit (default 50, max 100).",
          },
          channel_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional channel id list to scan instead of DISCORD_SCAN_CHANNEL_IDS.",
          },
          before_message_id: {
            type: "string",
            description: "Optional message id cursor for older backfill scans.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_inbox",
      description:
        "List Discord inbox items tracked in local state. Default status filter is pending; optionally include seen/acted/ignored.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum rows to return (default 20, max 200).",
          },
          status: {
            type: "string",
            description: "Comma-separated statuses: pending,seen,acted,ignored. Defaults to pending.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_backread",
      description:
        "Read stored Discord message history for a channel from local state, newest first.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id." },
          limit: {
            type: "integer",
            description: "Maximum rows to return (default 40, max 200).",
          },
          before_message_id: {
            type: "string",
            description: "Optional cursor message id to fetch older rows.",
          },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_mark",
      description:
        "Set decision state for a Discord inbox item so future scans remember handled/ignored choices.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "Inbox item id (usually message id)." },
          status: {
            type: "string",
            enum: ["pending", "seen", "acted", "ignored"],
          },
          action: {
            type: "string",
            enum: ["none", "replied", "messaged", "dismissed", "noted"],
          },
          note: {
            type: "string",
            description: "Optional decision note.",
          },
        },
        required: ["item_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_send",
      description:
        "Send a Discord message. reply_mode=auto sends plain unless conversation continuity is ambiguous, then it uses an explicit reply reference.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Target channel id." },
          content: { type: "string", description: "Message content to send." },
          source_item_id: {
            type: "string",
            description: "Optional inbox item id to mark as acted after sending.",
          },
          reference_message: {
            type: "string",
            description: "Optional specific message to treat as reply target. Provide message content, username (for their latest message), or message id",
          },
          reply_mode: {
            type: "string",
            enum: ["auto", "plain", "explicit"],
            description: "Reply behavior policy (default auto).",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channels",
      description:
        "List known Discord channels with id-to-name mapping, guild context, and optional channel notes.",
      parameters: {
        type: "object",
        properties: {
          include_unconfigured: {
            type: "boolean",
            description: "When true (default), include channels seen in history even if not in DISCORD_SCAN_CHANNEL_IDS.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channel_note",
      description:
        "Set or clear a persistent note for a Discord channel id. Pass empty note to clear.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id to annotate." },
          note: { type: "string", description: "Channel-specific note text. Empty string clears it." },
        },
        required: ["channel_id", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Pause and wait for the next incoming message or event. Use this when you've finished what you're doing and want to hear back before continuing.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_then_continue",
      description:
        "Wait for a short delay, then continue to another assistant turn without waiting for a new external event. Use this after a timeout or recoverable tool error when you still want to keep working. Accepts timeout_ms (default 10000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          timeout_ms: {
            type: "integer",
            description: "Delay before continuing in milliseconds. Defaults to 10000. Max 600000.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rest",
      description: "Go to sleep and end this session. Call this when you're truly done for now — conversation context will be cleared.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional note to yourself about where you left off.",
          },
        },
      },
    },
  },
]

/**
 * Persists the current message array as the resumable session snapshot.
 *
 * @param messages - Conversation messages to serialize.
 */
export async function saveSession(messages: Message[]): Promise<void> {
  await fs.writeFile(SESSION_FILE, JSON.stringify(messages), { encoding: "utf-8", mode: 0o666 })
}

/**
 * Deletes the persisted session snapshot if it exists.
 */
export async function clearSession(): Promise<void> {
  await fs.unlink(SESSION_FILE).catch(() => {})
}

/** Move any mis-ordered tool responses back to immediately after their assistant message. */
function sanitizeMessages(msgs: Message[]): Message[] {
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]
    if (msg.role === "assistant" && Array.isArray((msg as OpenAI.Chat.ChatCompletionMessage).tool_calls)) {
      const toolCalls = (msg as OpenAI.Chat.ChatCompletionMessage).tool_calls!
      const needed = new Set(toolCalls.map((tc) => tc.id))
      let j = i + 1
      // Skip tool messages that are already in place
      while (j < msgs.length && msgs[j].role === "tool" && needed.has((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)) {
        needed.delete((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)
        j++
      }
      if (needed.size > 0) {
        // Collect stray tool responses and non-tool messages from the rest of the array
        const toolResponses: Message[] = []
        const others: Message[] = []
        for (let k = j; k < msgs.length; k++) {
          const m = msgs[k]
          if (m.role === "tool" && needed.has((m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)) {
            toolResponses.push(m)
            needed.delete((m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)
          } else {
            others.push(m)
          }
          if (needed.size === 0) {
            const rest = msgs.slice(k + 1)
            msgs = [...msgs.slice(0, j), ...toolResponses, ...others, ...rest]
            console.log(`[runner] repaired orphaned tool_calls at message ${i}`)
            break
          }
        }
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
 * Determines whether an error should trigger fallback model routing.
 *
 * @param err - Error thrown by the primary API call.
 * @returns `true` when fallback should be attempted.
 */
export function shouldFallback(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    // 429 + 5xx = overloaded or down; 0/undefined = network-level failure
    return !err.status || err.status === 429 || err.status >= 500
  }
  // Node fetch errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT…)
  if (err instanceof Error) {
    return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed/i.test(err.message)
  }
  return false
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
  "Compressed notes of older conversation turns. If anything conflicts, trust newer raw messages."
const CONTEXT_SUMMARY_SEGMENTS_MARKER = "[segments]"
const CONTEXT_SUMMARY_DELIMITER = "\n\n===\n\n"
const SUMMARY_LINE_MAX_CHARS = 180
const SUMMARY_LINE_DEFAULT_EMPTY = "(no text)"

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

function assistantToolNames(message: Message): string[] {
  const record = asRecord(message)
  const calls = record?.tool_calls
  if (!Array.isArray(calls)) return []

  const names: string[] = []
  for (const call of calls) {
    const callRecord = asRecord(call)
    const fn = asRecord(callRecord?.function)
    if (typeof fn?.name === "string" && fn.name.trim()) names.push(fn.name.trim())
  }
  return names
}

function assistantToolCallIds(message: Message): Set<string> {
  const ids = new Set<string>()
  const record = asRecord(message)
  const calls = record?.tool_calls
  if (!Array.isArray(calls)) return ids

  for (const call of calls) {
    const callRecord = asRecord(call)
    if (typeof callRecord?.id === "string" && callRecord.id.trim()) ids.add(callRecord.id.trim())
  }
  return ids
}

function toolCallId(message: Message): string | null {
  const record = asRecord(message)
  return typeof record?.tool_call_id === "string" && record.tool_call_id.trim() ? record.tool_call_id.trim() : null
}

function summarizeMessageLine(message: Message): string {
  const role = messageRole(message)
  const content = truncateSummaryText(normalizeSummaryText(messageStringContent(message)), SUMMARY_LINE_MAX_CHARS)
  const safeContent = content || SUMMARY_LINE_DEFAULT_EMPTY

  if (role === "assistant") {
    const toolNames = assistantToolNames(message)
    if (toolNames.length > 0 && content) return `- assistant: ${safeContent} | tools: ${toolNames.join(", ")}`
    if (toolNames.length > 0) return `- assistant: tools: ${toolNames.join(", ")}`
    return `- assistant: ${safeContent}`
  }
  if (role === "tool") {
    const id = toolCallId(message) ?? "unknown"
    return `- tool(${id}): ${safeContent}`
  }
  if (role === "user") return `- user: ${safeContent}`
  if (role === "system") return `- system: ${safeContent}`
  return `- ${role || "message"}: ${safeContent}`
}

function buildCompactionSegment(messages: Message[]): string {
  const lines = messages.map((message) => summarizeMessageLine(message))
  const summaryLines = lines.length > 0 ? lines.join("\n") : `- ${SUMMARY_LINE_DEFAULT_EMPTY}`
  return `[${new Date().toISOString()}] compacted ${messages.length} messages\n${summaryLines}`
}

function buildSummaryMessageContent(segments: string[]): string {
  const body = segments.join(CONTEXT_SUMMARY_DELIMITER)
  return `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n${body}`
}

function parseSummarySegments(content: string): string[] {
  if (!content.startsWith(CONTEXT_SUMMARY_HEADER)) return []

  const marker = `\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n`
  const markerIndex = content.indexOf(marker)
  if (markerIndex === -1) return []

  const body = content.slice(markerIndex + marker.length).trim()
  if (!body) return []

  return body
    .split(CONTEXT_SUMMARY_DELIMITER)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function trimSummarySegments(segments: string[], maxChars: number): string[] {
  const safeMaxChars = Math.max(1024, maxChars)
  const next = [...segments]

  while (next.length > 1 && buildSummaryMessageContent(next).length > safeMaxChars) {
    next.shift()
  }

  if (next.length === 0) return next

  const current = buildSummaryMessageContent(next)
  if (current.length <= safeMaxChars) return next

  const fixedPrefix = buildSummaryMessageContent([]).length
  const available = Math.max(0, safeMaxChars - fixedPrefix)
  next[0] = truncateSummaryText(next[0]!, available)
  return next
}

function countLeadingSystemMessages(messages: Message[]): number {
  let count = 0
  while (count < messages.length && messageRole(messages[count]!) === "system") count++
  return count
}

function findSummaryMessageIndex(messages: Message[]): number {
  return messages.findIndex((message) => {
    const content = messageStringContent(message)
    return content.startsWith(CONTEXT_SUMMARY_HEADER)
  })
}

/**
 * Very rough tokenizer-agnostic estimate for prompt size guardrails.
 *
 * Includes both messages and tool schema to mirror completion request payload.
 */
export function estimatePromptTokens(messages: Message[]): number {
  const jsonChars = JSON.stringify({ messages, tools: TOOLS }).length
  return Math.ceil(jsonChars / 4)
}

export type ContextCompactionResult = {
  compacted: boolean
  messages: Message[]
  estimateBefore: number
  estimateAfter: number
  messagesRemoved: number
  chunks: number
}

function normalizedObservedPromptTokens(value: number | undefined): number | null {
  if (!Number.isFinite(value)) return null
  const tokens = Math.ceil(value as number)
  return tokens > 0 ? tokens : null
}

/**
 * Applies rolling context compaction when estimated prompt size exceeds threshold.
 *
 * Keeps leading bootstrap system messages and recent raw turns, while replacing
 * older slices with a durable summary message.
 */
export function maybeCompactConversation(messages: Message[], observedPromptTokens?: number): ContextCompactionResult {
  const estimateBefore = estimatePromptTokens(messages)
  const observedBefore = normalizedObservedPromptTokens(observedPromptTokens)
  // Calibrate the rough chars/4 heuristic with real API prompt usage when available.
  const estimateScale = observedBefore ? Math.max(1, observedBefore / Math.max(1, estimateBefore)) : 1
  const effectiveBefore = Math.ceil(estimateBefore * estimateScale)

  if (effectiveBefore < CONTEXT_COMPACT_TRIGGER_TOKENS) {
    return {
      compacted: false,
      messages,
      estimateBefore: effectiveBefore,
      estimateAfter: effectiveBefore,
      messagesRemoved: 0,
      chunks: 0,
    }
  }

  const chunkSize = Math.max(1, CONTEXT_COMPACT_CHUNK_MESSAGES)
  const minRecentMessages = Math.max(1, CONTEXT_COMPACT_RECENT_MESSAGES)
  let next = [...messages]
  let summaryIndex = findSummaryMessageIndex(next)
  let summaryInserted = false
  let summarySegments: string[] = []

  if (summaryIndex >= 0) {
    const existingContent = messageStringContent(next[summaryIndex]!)
    summarySegments = parseSummarySegments(existingContent)
  } else {
    const baseLayerEnd = (() => {
      const leadingSystems = countLeadingSystemMessages(next)
      if (leadingSystems > 0) return leadingSystems
      return next.length > 0 ? 1 : 0
    })()
    summaryIndex = Math.min(baseLayerEnd, next.length)
    next.splice(summaryIndex, 0, {
      role: "user",
      content: buildSummaryMessageContent([]),
    })
    summaryInserted = true
  }

  let estimateAfter = estimatePromptTokens(next)
  let effectiveAfter = Math.ceil(estimateAfter * estimateScale)
  let messagesRemoved = 0
  let chunks = 0

  while (effectiveAfter > CONTEXT_COMPACT_TARGET_TOKENS) {
    const compactStart = summaryIndex + 1
    const protectedTailStart = Math.max(compactStart, next.length - minRecentMessages)
    if (protectedTailStart <= compactStart) break

    let compactEnd = Math.min(protectedTailStart, compactStart + chunkSize)
    if (compactEnd <= compactStart) break

    while (compactEnd < protectedTailStart && messageRole(next[compactEnd]!) === "tool") {
      compactEnd++
    }

    const unresolvedToolCalls = assistantToolCallIds(next[compactEnd - 1]!)
    if (unresolvedToolCalls.size > 0) {
      let scan = compactEnd
      while (scan < protectedTailStart && messageRole(next[scan]!) === "tool") {
        const id = toolCallId(next[scan]!)
        if (id) unresolvedToolCalls.delete(id)
        scan++
        if (unresolvedToolCalls.size === 0) break
      }
      compactEnd = scan
    }

    while (compactEnd < protectedTailStart && messageRole(next[compactEnd]!) === "tool") {
      compactEnd++
    }

    if (compactEnd <= compactStart) break

    const removed = next.slice(compactStart, compactEnd)
    if (removed.length === 0) break

    summarySegments.push(buildCompactionSegment(removed))
    summarySegments = trimSummarySegments(summarySegments, CONTEXT_COMPACT_SUMMARY_MAX_CHARS)

    next[summaryIndex] = {
      role: "user",
      content: buildSummaryMessageContent(summarySegments),
    }
    next.splice(compactStart, removed.length)

    messagesRemoved += removed.length
    chunks += 1
    estimateAfter = estimatePromptTokens(next)
    effectiveAfter = Math.ceil(estimateAfter * estimateScale)
  }

  if (messagesRemoved === 0 && summaryInserted) {
    next.splice(summaryIndex, 1)
    estimateAfter = estimatePromptTokens(next)
    effectiveAfter = Math.ceil(estimateAfter * estimateScale)
  }

  return {
    compacted: messagesRemoved > 0,
    messages: next,
    estimateBefore: effectiveBefore,
    estimateAfter: effectiveAfter,
    messagesRemoved,
    chunks,
  }
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
