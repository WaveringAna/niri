import {
  classifyCompletionError,
  errorSummary,
  isPromptTooLargeError,
  retryDelayMs,
  shouldFallback,
  shouldRetryProvider,
} from "./errors.js"
import type {
  CompletionErrorKind,
  CompletionOptions,
  CompletionRequest,
  CompletionTurnResult,
  Provider,
  ProviderSet,
  ProviderSlot,
} from "./types.js"

/**
 * Failure-tolerant completion.
 *
 * Extracted from `fetchCompletion` in `@niri/runtime`'s `loop-completion.ts`,
 * which had accumulated 250+ lines of hard-won recovery around a one-line API
 * call: primary/fallback routing, quota failover, backoff, prompt-size retry,
 * and content-filter recovery. That is provider behavior, not loop behavior, so
 * it belongs here — and a reviewer working through a large diff needs the
 * prompt-size handling just as much as a chat agent does.
 *
 * Recovery that requires *mutating the conversation* (dropping images,
 * redacting a blocked message, compacting) stays with the caller, which owns
 * those messages. This layer asks via {@link RecoveryHooks} and retries when the
 * caller reports it changed something.
 */

export type RecoveryHooks = {
  /**
   * The prompt exceeded the provider's limit. Shrink it and return true to
   * retry; return false to give up and let the error propagate.
   */
  onPromptTooLarge?(attempt: number): Promise<boolean> | boolean
  /**
   * The provider rejected content (a safety filter, or an image it could not
   * parse). Both stick across turns when the offending content is persisted in
   * the conversation, which crash-loops an agent on restart. Mutate and return
   * true to retry.
   */
  onContentRejected?(kind: "content_filter" | "image_parse", attempt: number): Promise<boolean> | boolean
  /**
   * Messages to send. Re-invoked on every attempt so recovery edits take
   * effect, and so per-turn preparation (passive memory recall, sanitization)
   * re-runs against the corrected conversation rather than a stale copy.
   */
  currentMessages(): CompletionRequest["messages"] | Promise<CompletionRequest["messages"]>
  /** Notified before each backoff sleep, for logging. */
  onRetry?(info: { slot: ProviderSlot; kind: CompletionErrorKind; delayMs: number; error: unknown }): void
}

export type ResilientCompletionConfig = {
  /** Attempts at shrinking an over-large prompt before giving up. */
  maxPromptTooLargeAttempts: number
  /** Same-provider retries for transient/rate-limit failures. */
  maxRetries: number
  /** Ceiling on any single backoff. */
  maxRetryDelayMs: number
}

export const defaultResilienceConfig: ResilientCompletionConfig = {
  maxPromptTooLargeAttempts: 2,
  maxRetries: 3,
  maxRetryDelayMs: 60_000,
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class Attempted extends Error {
  constructor(readonly slot: ProviderSlot, readonly cause: unknown) {
    super(errorSummary(cause))
  }
}

async function attempt(
  provider: Provider,
  slot: ProviderSlot,
  request: CompletionRequest,
  options: CompletionOptions,
): Promise<CompletionTurnResult> {
  try {
    return await provider.complete(request, options)
  } catch (err) {
    throw new Attempted(slot, err)
  }
}

/**
 * Runs one completion, recovering from what can be recovered from.
 *
 * Order matters. Prompt-size and content rejections are handled first because
 * they are deterministic: retrying them against a different provider or after a
 * delay fails identically. Only genuinely transient failures reach the retry
 * and fallback paths.
 */
export async function completeWithResilience(
  providers: ProviderSet,
  request: CompletionRequest,
  hooks: RecoveryHooks,
  options: CompletionOptions = {},
  config: ResilientCompletionConfig = defaultResilienceConfig,
): Promise<CompletionTurnResult> {
  let promptTooLargeAttempts = 0
  let contentRecoveryAttempts = 0
  let retries = 0

  while (true) {
    const resolved = await providers.resolvePrimary()
    if (!resolved) throw new Error("no model provider is configured")

    const current: CompletionRequest = {
      ...request,
      model: resolved.provider.model,
      tool_choice: resolved.provider.toolChoice,
      messages: await hooks.currentMessages(),
    }

    try {
      const result = await attempt(resolved.provider, resolved.slot, current, options)
      providers.recordSuccess(resolved.provider)
      return result
    } catch (thrown) {
      const { slot, cause: err } = thrown instanceof Attempted
        ? thrown
        : new Attempted(resolved.slot, thrown)
      const kind = classifyCompletionError(err)

      // ── deterministic failures: fix the input or give up ────────────────
      if (isPromptTooLargeError(err)) {
        if (promptTooLargeAttempts >= config.maxPromptTooLargeAttempts) throw err
        promptTooLargeAttempts++
        const shrank = await hooks.onPromptTooLarge?.(promptTooLargeAttempts)
        if (!shrank) throw err
        continue
      }

      if (kind === "content_filter" || kind === "image_parse") {
        if (contentRecoveryAttempts >= 2) throw err
        contentRecoveryAttempts++
        const recovered = await hooks.onContentRejected?.(kind, contentRecoveryAttempts)
        if (!recovered) throw err
        continue
      }

      // ── quota: fail over to the fallback endpoint for a long while ──────
      if (kind === "quota_exhausted" && slot === "primary") {
        const status = await providers.recordQuotaFailover(err)
        console.warn(
          `[api] primary quota exhausted (${errorSummary(err)}); ` +
            `failing over until ${new Date(status.retryAtMs).toISOString()}`,
        )
        if (providers.fallback) continue
        throw err
      }

      // ── transient: back off, then retry or fall over ────────────────────
      const retryable = shouldRetryProvider(err) || shouldFallback(err)
      if (!retryable || retries >= config.maxRetries) {
        providers.recordFailure(resolved.provider, err)
        throw err
      }
      retries++
      providers.recordFailure(resolved.provider, err)
      const delayMs = Math.min(config.maxRetryDelayMs, retryDelayMs(err))
      hooks.onRetry?.({ slot, kind, delayMs, error: err })
      console.warn(`[api] ${slot} ${kind} (${errorSummary(err)}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }
}
