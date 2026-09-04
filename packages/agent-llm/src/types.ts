import type OpenAI from "openai"

/**
 * Wire protocol spoken to a model endpoint.
 *
 * Only two exist. Anything OpenAI-compatible (OpenRouter, LM Studio, vLLM,
 * Together, DeepSeek) is `"openai"` with a different `baseUrl`.
 */
export type ProviderKind = "openai" | "anthropic"

export type ToolChoice = "required" | "auto" | "none"

/** Which configured endpoint a completion was served by. */
export type ProviderSlot = "primary" | "fallback" | "summary"

/**
 * A client-enforced context ceiling, for endpoints that hard-fail instead of
 * returning a clean `context_length_exceeded` (local llama.cpp servers).
 */
export type ContextWindowLimit = {
  /** Total context the endpoint was launched with. */
  nCtx: number
  /** Tokens held back for the completion itself. */
  margin: number
  /** Refuse the request outright past this much overflow. */
  hardOverflowTokens: number
}

/**
 * One fully-resolved model endpoint. Every field is explicit: nothing is read
 * from `process.env` below this type. Build it with {@link resolveProviderConfig}
 * or by hand in a test.
 */
export type ProviderEndpointConfig = {
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  toolChoice: ToolChoice
  /** Extra headers merged into every request (User-Agent, HTTP-Referer, X-Title). */
  headers?: Record<string, string>
  /** Anthropic only: required `max_tokens`. */
  maxTokens?: number
  /** Anthropic only: `anthropic-version` header. */
  apiVersion?: string
  /** Anthropic only: extended-thinking token budget; 0 disables. */
  thinkingBudget?: number
  /**
   * Provider requires prior assistant reasoning blocks to be replayed verbatim
   * on the next request (DeepSeek). Drives message sanitization.
   */
  requiresReasoningReplay?: boolean
  /** Client-side context ceiling; null for hosted endpoints that report their own. */
  contextWindow?: ContextWindowLimit | null
  /**
   * Endpoint honours `prompt_cache_key`. Only official OpenAI does; sending it
   * to a strict gateway earns a 400, so it stays off by default.
   */
  supportsPromptCacheKey?: boolean
  /**
   * Explicit cache key. When absent and {@link supportsPromptCacheKey} is set,
   * the provider derives `${agentId}:${slot}`.
   */
  promptCacheKey?: string
}

/**
 * The three endpoints an agent can address, plus cross-cutting completion
 * behavior. `primary` is null only when the deployment is pinned to fallback.
 */
export type ProviderConfig = {
  primary: ProviderEndpointConfig | null
  fallback: ProviderEndpointConfig | null
  summary: ProviderEndpointConfig | null
  /** Request and stream model reasoning. */
  enableThinking: boolean
  /** How long a quota-exhausted primary stays failed over. */
  quotaRetryMs: number
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** Provider-agnostic request body. Adapters translate this to their wire format. */
export type CompletionRequest = {
  model: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools: OpenAI.Chat.ChatCompletionTool[]
  tool_choice: ToolChoice
  prompt_cache_key?: string
  include_reasoning?: boolean
  reasoning?: {
    enabled?: boolean
    exclude?: boolean
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  }
  provider?: { require_parameters?: boolean }
  enable_thinking?: boolean
  chat_template_kwargs?: { enable_thinking?: boolean }
}

export type CompletionTurnResult = {
  message: OpenAI.Chat.ChatCompletionMessage
  usage?: OpenAI.Completions.CompletionUsage
  /** Assistant text was already streamed to the sink; don't re-emit it. */
  emittedText: boolean
  /** Reasoning was already streamed to the sink; don't re-emit it. */
  emittedThinking: boolean
  /** Reasoning captured when streaming could not emit it live. */
  bufferedThinking: string
  elapsedMs?: number
  tokensPerSecond?: number
  /** Which endpoint actually served this turn. */
  servedBy?: ProviderSlot
}

/** A streaming tool call being reassembled from deltas. */
export type ToolCallAssembly = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/**
 * Sink for streamed completion output. `@mira/agent-loop` supplies one that
 * forwards to the host's event stream; summarization passes `null` to stay silent.
 */
export interface CompletionStreamSink {
  onText(delta: string): void
  onThinking(delta: string): void
}

export type CompletionOptions = {
  toolChoice?: ToolChoice
  /** Stream deltas here. Omit for a silent (non-user-facing) completion. */
  sink?: CompletionStreamSink | null
  /** Override the endpoint's configured model for this one call. */
  model?: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** A single live endpoint. Stateless apart from its HTTP client. */
export interface Provider {
  /** Stable circuit-breaker key: `${baseUrl}\n${model}`. */
  readonly id: string
  readonly kind: ProviderKind
  readonly model: string
  readonly baseUrl: string
  readonly toolChoice: ToolChoice
  readonly config: ProviderEndpointConfig
  complete(request: CompletionRequest, options?: CompletionOptions): Promise<CompletionTurnResult>
}

/**
 * Persisted quota-failover state. Survives restarts so a 24h quota ban is not
 * re-probed on every boot.
 */
export type FailoverStatus = {
  active: boolean
  retryAtMs: number
  reason: string | null
}

/** Per-provider circuit breaker, used to stop hammering a broken summary model. */
export type CircuitStatus = {
  open: boolean
  permanent: boolean
  disabledUntil?: number
  reason?: string
}

/**
 * Durable store for failover state. File-backed in production, in-memory in tests.
 */
export interface FailoverStore {
  load(): Promise<FailoverStatus | null>
  save(status: FailoverStatus): Promise<void>
  clear(): Promise<boolean>
}

/**
 * The resolved provider set an agent runs against, with failover and circuit
 * breaking applied. This is what `@mira/agent-loop` depends on — it never sees
 * `ProviderEndpointConfig` or an `OpenAI` client directly.
 */
export interface ProviderSet {
  readonly primary: Provider | null
  readonly fallback: Provider | null
  readonly summary: Provider | null
  readonly enableThinking: boolean

  /** Endpoint for a user-facing turn, honouring an active quota failover. */
  resolvePrimary(): Promise<{ provider: Provider; slot: ProviderSlot } | null>

  /**
   * Endpoint for summarization/compaction. Returns null when the chosen
   * provider's circuit is open, so the caller can skip compaction rather than
   * stall the loop.
   */
  resolveSummary(): Promise<{ provider: Provider; slot: ProviderSlot } | null>

  failoverStatus(nowMs?: number): Promise<FailoverStatus>
  recordQuotaFailover(err: unknown, nowMs?: number): Promise<FailoverStatus>
  clearFailover(): Promise<boolean>

  circuitStatus(provider: Provider): CircuitStatus
  recordFailure(provider: Provider, err: unknown): void
  recordUnusable(provider: Provider, reason: string): void
  recordSuccess(provider: Provider): void
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Normalized reason a completion failed. Adapters map provider-specific error
 * bodies onto this so the loop's recovery logic is provider-agnostic.
 */
export type CompletionErrorKind =
  | "quota_exhausted"
  | "prompt_too_large"
  | "content_filter"
  | "image_parse"
  | "transient_transport"
  | "rate_limited"
  | "unknown"

export interface CompletionErrorClassifier {
  classify(err: unknown): CompletionErrorKind
  /** Suggested backoff, honouring `Retry-After` and reset-timestamp hints. */
  retryDelayMs(err: unknown): number
  /** Whether the same endpoint is worth another attempt. */
  shouldRetry(err: unknown): boolean
  /** Whether to give up on primary and try the fallback endpoint. */
  shouldFallback(err: unknown): boolean
  /** Human-readable one-liner for logs. */
  summarize(err: unknown): string
  /** Multi-line provider error body, for operator logs. */
  details(err: unknown): string[]
}
