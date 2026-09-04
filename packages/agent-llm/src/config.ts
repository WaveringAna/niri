import type {
  ContextWindowLimit,
  ProviderConfig,
  ProviderEndpointConfig,
  ToolChoice,
} from "./types.js"

/**
 * An environment-shaped record. Callers pass `process.env` (or a literal, in
 * tests). Nothing in this package reads the real environment on its own — that
 * is the whole point of Phase 1.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderConfigError"
  }
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com/v1"
const DEFAULT_FALLBACK_BASE = "http://localhost:1234/v1"
const DEFAULT_ANTHROPIC_VERSION = "2024-10-22"

export function isLikelyLocalBase(baseUrl: string): boolean {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (["true", "1", "yes", "on"].includes(normalized)) return true
  if (["false", "0", "no", "off"].includes(normalized)) return false
  return fallback
}

export function parseToolChoiceEnv(value: string | undefined, fallback: ToolChoice): ToolChoice {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "required" || normalized === "auto" || normalized === "none") return normalized
  return fallback
}

function parseIntEnv(value: string | undefined, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? `${fallback}`, 10)
  return Math.max(min, Number.isFinite(parsed) ? parsed : fallback)
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim()
  return out ? out : undefined
}

function headers(entries: readonly (readonly [string, string | undefined])[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [name, value] of entries) {
    const headerValue = trimmed(value)
    if (headerValue) out[name] = headerValue
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * `deepseek` replays prior reasoning blocks back into the request; sending a
 * conversation without them produces a 400. Detected by URL or model name
 * because the provider does not advertise it.
 */
function requiresReasoningReplay(baseUrl: string, model: string): boolean {
  return baseUrl.toLowerCase().includes("deepseek") || model.toLowerCase().includes("deepseek")
}

/** Tolerates a malformed base URL; the request itself will surface the error. */
function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com"
  } catch {
    return false
  }
}

/**
 * Resolves the full provider configuration from an environment-shaped record.
 *
 * Pure: no I/O, no globals, no `process.env`, and it throws rather than
 * `process.exit`s. Importing this module has no side effects, which is what
 * lets the loop, the summarizer, and tests each build their own config — and
 * what lets two agents with different models share one process.
 */
export function resolveProviderConfig(env: EnvLike): ProviderConfig {
  const useFallbackOnly = (env.NIRI_ENV ?? env.AGENT_ENV ?? "default").trim().toLowerCase() === "local"
  const useAnthropic = parseBooleanEnv(env.USE_ANTHROPIC, false)
  const enableThinking = parseBooleanEnv(env.ENABLE_THINKING, true)
  const promptCacheKey = trimmed(env.OPENAI_PROMPT_CACHE_KEY)
  const userAgent = trimmed(env.OPENAI_USER_AGENT)

  // ── primary ──────────────────────────────────────────────────────────────
  let primary: ProviderEndpointConfig | null = null
  if (!useFallbackOnly) {
    if (useAnthropic) {
      const apiKey = env.ANTHROPIC_API_KEY ?? ""
      const model = env.ANTHROPIC_MODEL ?? ""
      if (!apiKey) throw new ProviderConfigError("ANTHROPIC_API_KEY is required when USE_ANTHROPIC=true.")
      if (!model) throw new ProviderConfigError("ANTHROPIC_MODEL is required when USE_ANTHROPIC=true.")
      primary = {
        kind: "anthropic",
        baseUrl: env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE,
        apiKey,
        model,
        toolChoice: parseToolChoiceEnv(env.PRIMARY_TOOL_CHOICE ?? env.TOOL_CHOICE, "auto"),
        maxTokens: parseIntEnv(env.ANTHROPIC_MAX_TOKENS, 8192, 1),
        apiVersion: env.ANTHROPIC_VERSION ?? DEFAULT_ANTHROPIC_VERSION,
        thinkingBudget: enableThinking ? parseIntEnv(env.ANTHROPIC_THINKING_BUDGET, 4096, 1024) : 0,
        contextWindow: null,
      }
    } else {
      const baseUrl = env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE
      const model = env.MODEL ?? ""
      const apiKey = env.OPENAI_API_KEY ?? ""
      const primaryHeaders = headers([["User-Agent", userAgent]])
      if (!model) {
        throw new ProviderConfigError(
          "MODEL is required unless the deployment is pinned to fallback (NIRI_ENV=local) or Anthropic is used (USE_ANTHROPIC=true).",
        )
      }
      if (!apiKey) {
        throw new ProviderConfigError(
          "OPENAI_API_KEY is required unless the deployment is pinned to fallback (NIRI_ENV=local) or Anthropic is used (USE_ANTHROPIC=true).",
        )
      }
      primary = {
        kind: "openai",
        baseUrl,
        apiKey,
        model,
        toolChoice: parseToolChoiceEnv(env.PRIMARY_TOOL_CHOICE ?? env.TOOL_CHOICE, "auto"),
        ...(primaryHeaders ? { headers: primaryHeaders } : {}),
        requiresReasoningReplay: requiresReasoningReplay(baseUrl, model),
        contextWindow: null,
        // Only official OpenAI honours prompt_cache_key; strict gateways 400 on it.
        supportsPromptCacheKey: Boolean(promptCacheKey) || isOfficialOpenAI(baseUrl),
        ...(promptCacheKey ? { promptCacheKey } : {}),
      }
    }
  }

  // ── fallback ─────────────────────────────────────────────────────────────
  const fallbackBase =
    env.FALLBACK_OPENAI_BASE_URL ?? env.OPENROUTER_BASE_URL ?? env.LMSTUDIO_BASE_URL ?? DEFAULT_FALLBACK_BASE
  const fallbackModel =
    env.FALLBACK_MODEL ?? env.OPENROUTER_MODEL ?? env.LMSTUDIO_MODEL ?? "zai-org/glm-4.7-flash"
  const fallbackApiKey =
    env.FALLBACK_OPENAI_API_KEY ??
    env.OPENROUTER_API_KEY ??
    env.LMSTUDIO_API_KEY ??
    env.OPENAI_API_KEY ??
    (isLikelyLocalBase(fallbackBase) ? "lm-studio" : "")
  if (useFallbackOnly && !fallbackApiKey) {
    throw new ProviderConfigError(
      "Fallback API key is required when pinned to fallback. Set FALLBACK_OPENAI_API_KEY (or OPENROUTER_API_KEY / LMSTUDIO_API_KEY).",
    )
  }
  const enforceFallbackWindow = parseBooleanEnv(
    env.FALLBACK_ENFORCE_CONTEXT_LIMIT,
    isLikelyLocalBase(fallbackBase),
  )
  const fallbackWindow: ContextWindowLimit | null = enforceFallbackWindow
    ? {
        nCtx: parseIntEnv(env.FALLBACK_N_CTX ?? env.LMSTUDIO_N_CTX, 4096, 1),
        margin: parseIntEnv(env.FALLBACK_CONTEXT_MARGIN ?? env.LMSTUDIO_CONTEXT_MARGIN, 256, 0),
        hardOverflowTokens: parseIntEnv(
          env.FALLBACK_HARD_OVERFLOW_TOKENS ?? env.LMSTUDIO_HARD_OVERFLOW_TOKENS,
          1024,
          0,
        ),
      }
    : null
  const fallbackHeaders = headers([
    ["HTTP-Referer", env.FALLBACK_OPENAI_REFERER],
    ["X-Title", env.FALLBACK_OPENAI_TITLE],
    ["User-Agent", trimmed(env.FALLBACK_OPENAI_USER_AGENT) ?? userAgent],
  ])
  const fallback: ProviderEndpointConfig = {
    kind: "openai",
    baseUrl: fallbackBase,
    // LM Studio ignores the key but the SDK requires a non-empty string.
    apiKey: fallbackApiKey || "lm-studio",
    model: fallbackModel,
    toolChoice: parseToolChoiceEnv(env.FALLBACK_TOOL_CHOICE, "auto"),
    ...(fallbackHeaders ? { headers: fallbackHeaders } : {}),
    requiresReasoningReplay: requiresReasoningReplay(fallbackBase, fallbackModel),
    contextWindow: fallbackWindow,
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const summaryBase = env.SUMMARY_OPENAI_BASE_URL ?? env.SUMMARY_BASE_URL ?? ""
  const summaryModel = env.SUMMARY_MODEL ?? ""
  const summaryApiKey =
    env.SUMMARY_OPENAI_API_KEY ??
    env.SUMMARY_API_KEY ??
    (summaryBase && summaryBase === env.OPENROUTER_BASE_URL ? env.OPENROUTER_API_KEY : undefined) ??
    (summaryBase && summaryBase === env.LMSTUDIO_BASE_URL ? env.LMSTUDIO_API_KEY : undefined) ??
    env.OPENAI_API_KEY ??
    (summaryBase && isLikelyLocalBase(summaryBase) ? "lm-studio" : "")
  if ((summaryBase || summaryModel) && (!summaryBase || !summaryModel || !summaryApiKey)) {
    throw new ProviderConfigError(
      "Summary provider requires SUMMARY_OPENAI_BASE_URL (or SUMMARY_BASE_URL), SUMMARY_MODEL, and SUMMARY_OPENAI_API_KEY (or SUMMARY_API_KEY).",
    )
  }
  const summaryHeaders = headers([
    ["HTTP-Referer", env.SUMMARY_OPENAI_REFERER],
    ["X-Title", env.SUMMARY_OPENAI_TITLE],
    ["User-Agent", trimmed(env.SUMMARY_OPENAI_USER_AGENT) ?? userAgent],
  ])
  const summary: ProviderEndpointConfig | null =
    summaryBase && summaryModel
      ? {
          kind: "openai",
          baseUrl: summaryBase,
          apiKey: summaryApiKey,
          model: summaryModel,
          toolChoice: "none",
          ...(summaryHeaders ? { headers: summaryHeaders } : {}),
          requiresReasoningReplay: requiresReasoningReplay(summaryBase, summaryModel),
          contextWindow: null,
        }
      : null

  return {
    primary,
    fallback,
    summary,
    enableThinking,
    quotaRetryMs: parseIntEnv(env.PRIMARY_QUOTA_RETRY_MS, 24 * 60 * 60 * 1000, 60_000),
  }
}

/** One-line summary of resolved endpoints, for a host to log at startup. */
export function describeProviderConfig(config: ProviderConfig): string[] {
  const lines: string[] = []
  lines.push(
    config.primary
      ? `primary=${config.primary.model} @ ${config.primary.baseUrl} (${config.primary.kind})`
      : "primary=<pinned to fallback>",
  )
  if (config.fallback) lines.push(`fallback=${config.fallback.model} @ ${config.fallback.baseUrl}`)
  if (config.summary) lines.push(`summary=${config.summary.model} @ ${config.summary.baseUrl}`)
  lines.push(`thinking=${config.enableThinking}`)
  return lines
}
