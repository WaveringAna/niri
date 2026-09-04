import OpenAI from "openai"
import { errorSummary, isQuotaExhaustedError } from "./errors.js"
import { createAnthropicProvider } from "./anthropic-provider.js"
import { createOpenAIProvider } from "./openai-provider.js"
import type {
  CircuitStatus,
  FailoverStatus,
  FailoverStore,
  Provider,
  ProviderConfig,
  ProviderSet,
  ProviderSlot,
} from "./types.js"

/**
 * Failover and circuit breaking.
 *
 * Both used to be module-level `Map`s and file paths in `runner/util.ts`, which
 * meant a second agent in the same process shared one agent's quota ban. State
 * now lives on the instance.
 */

const TRANSIENT_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60_000
const UNUSABLE_BACKOFF_MS = 5 * 60_000
/** Auth/billing/not-found are configuration errors; retrying cannot fix them. */
const PERMANENT_STATUSES = new Set([401, 402, 403, 404])

type CircuitEntry = {
  failures: number
  disabledUntil: number
  permanent: boolean
  reason: string
}

/** Failover store that keeps state only for the life of the process. */
export function memoryFailoverStore(): FailoverStore {
  let current: FailoverStatus | null = null
  return {
    async load() {
      return current
    },
    async save(status) {
      current = status
    },
    async clear() {
      const had = current !== null
      current = null
      return had
    },
  }
}

export type ProviderSetDeps = {
  /** Namespaces derived prompt-cache keys. */
  agentId: string
  /** Durable quota-failover state; defaults to process-lifetime memory. */
  failoverStore?: FailoverStore
}

function buildProvider(
  config: ProviderConfig,
  slot: ProviderSlot,
  agentId: string,
): Provider | null {
  const endpoint = config[slot]
  if (!endpoint) return null
  const enableThinking = config.enableThinking
  return endpoint.kind === "anthropic"
    ? createAnthropicProvider(endpoint, { slot, enableThinking })
    : createOpenAIProvider(endpoint, { agentId, slot, enableThinking })
}

/**
 * Builds the live provider set from a resolved {@link ProviderConfig}.
 *
 * Constructing this performs no I/O and reads no environment — it only creates
 * SDK clients — so a host can build several, and a test can build one with a
 * literal config.
 */
export function createProviderSet(config: ProviderConfig, deps: ProviderSetDeps): ProviderSet {
  const agentId = deps.agentId
  const store = deps.failoverStore ?? memoryFailoverStore()

  const primary = buildProvider(config, "primary", agentId)
  const fallback = buildProvider(config, "fallback", agentId)
  const summary = buildProvider(config, "summary", agentId)

  const circuits = new Map<string, CircuitEntry>()
  let failoverLoaded = false
  let failoverRetryAtMs = 0
  let failoverReason: string | null = null

  function statusFromMemory(nowMs: number): FailoverStatus {
    return {
      active: failoverRetryAtMs > nowMs,
      retryAtMs: failoverRetryAtMs,
      reason: failoverRetryAtMs > nowMs ? failoverReason : null,
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (failoverLoaded) return
    failoverLoaded = true
    const persisted = await store.load().catch(() => null)
    if (!persisted) return
    failoverRetryAtMs = persisted.retryAtMs
    failoverReason = persisted.reason
  }

  function circuitStatus(provider: Provider, now = Date.now()): CircuitStatus {
    const entry = circuits.get(provider.id)
    if (!entry) return { open: false, permanent: false }
    const open = entry.permanent || entry.disabledUntil > now
    return {
      open,
      permanent: entry.permanent,
      ...(entry.permanent ? {} : { disabledUntil: entry.disabledUntil }),
      reason: entry.reason,
    }
  }

  return {
    primary,
    fallback,
    summary,
    enableThinking: config.enableThinking,

    async resolvePrimary() {
      await ensureLoaded()
      const failover = statusFromMemory(Date.now())
      if (!primary || failover.active) {
        return fallback ? { provider: fallback, slot: "fallback" as const } : null
      }
      return { provider: primary, slot: "primary" as const }
    },

    async resolveSummary() {
      // An explicitly configured summary model wins; otherwise reuse whichever
      // endpoint is currently serving turns.
      const chosen: { provider: Provider; slot: ProviderSlot } | null = summary
        ? { provider: summary, slot: "summary" }
        : await this.resolvePrimary()
      if (!chosen) return null
      // An open circuit means skip compaction this turn rather than stall the loop.
      return circuitStatus(chosen.provider).open ? null : chosen
    },

    async failoverStatus(nowMs = Date.now()) {
      await ensureLoaded()
      return statusFromMemory(nowMs)
    },

    async recordQuotaFailover(err, nowMs = Date.now()) {
      await ensureLoaded()
      if (!isQuotaExhaustedError(err)) return statusFromMemory(nowMs)
      failoverRetryAtMs = nowMs + config.quotaRetryMs
      failoverReason = errorSummary(err)
      const status = statusFromMemory(nowMs)
      await store.save(status).catch(() => {})
      return status
    },

    async clearFailover() {
      failoverLoaded = true
      const had = failoverRetryAtMs > 0
      failoverRetryAtMs = 0
      failoverReason = null
      await store.clear().catch(() => {})
      return had
    },

    circuitStatus,

    recordFailure(provider, err) {
      const now = Date.now()
      const previous = circuits.get(provider.id)
      const failures = (previous?.failures ?? 0) + 1
      const status = err instanceof OpenAI.APIError ? err.status : undefined
      const permanent = status !== undefined && PERMANENT_STATUSES.has(status)
      const transient = status === undefined || status === 429 || status >= 500
      const delay = transient
        ? Math.min(MAX_BACKOFF_MS, TRANSIENT_BACKOFF_MS * 2 ** Math.min(failures - 1, 8))
        : UNUSABLE_BACKOFF_MS
      circuits.set(provider.id, {
        failures,
        disabledUntil: permanent ? Number.POSITIVE_INFINITY : now + delay,
        permanent,
        reason: errorSummary(err),
      })
    },

    recordUnusable(provider, reason) {
      const now = Date.now()
      const failures = (circuits.get(provider.id)?.failures ?? 0) + 1
      circuits.set(provider.id, {
        failures,
        disabledUntil: now + Math.min(MAX_BACKOFF_MS, UNUSABLE_BACKOFF_MS * failures),
        permanent: false,
        reason,
      })
    },

    recordSuccess(provider) {
      circuits.delete(provider.id)
    },
  }
}
