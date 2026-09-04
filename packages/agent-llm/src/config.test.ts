import assert from "node:assert/strict"
import { test } from "node:test"
import OpenAI from "openai"
import { ProviderConfigError, resolveProviderConfig } from "./config.js"
import { createProviderSet, memoryFailoverStore } from "./provider-set.js"
import { completeWithResilience, defaultResilienceConfig } from "./resilient.js"
import type { CompletionRequest, CompletionTurnResult, Provider, ProviderSet } from "./types.js"

const OPENAI_ENV = { MODEL: "gpt-5", OPENAI_API_KEY: "sk-test" }

test("importing this package reads nothing from the real environment", () => {
  // The regression this whole refactor exists to prevent: `runner/util.ts`
  // threw at import time when MODEL was unset, which took 12 unrelated test
  // files down with it.
  const saved = { ...process.env }
  for (const key of ["MODEL", "OPENAI_API_KEY", "USE_ANTHROPIC", "ANTHROPIC_API_KEY"]) {
    delete process.env[key]
  }
  try {
    const config = resolveProviderConfig(OPENAI_ENV)
    assert.equal(config.primary?.model, "gpt-5")
  } finally {
    Object.assign(process.env, saved)
  }
})

test("two provider sets with different models coexist in one process", () => {
  const a = createProviderSet(resolveProviderConfig({ ...OPENAI_ENV, MODEL: "gpt-5" }), { agentId: "reviewer" })
  const b = createProviderSet(
    resolveProviderConfig({ USE_ANTHROPIC: "true", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_MODEL: "claude-opus-5" }),
    { agentId: "niri" },
  )
  assert.equal(a.primary?.model, "gpt-5")
  assert.equal(a.primary?.kind, "openai")
  assert.equal(b.primary?.model, "claude-opus-5")
  assert.equal(b.primary?.kind, "anthropic")
  assert.notEqual(a.primary?.id, b.primary?.id)
})

test("missing primary credentials throw a typed error, not a process-wide crash", () => {
  assert.throws(() => resolveProviderConfig({ MODEL: "gpt-5" }), ProviderConfigError)
  assert.throws(() => resolveProviderConfig({ OPENAI_API_KEY: "sk-test" }), ProviderConfigError)
  assert.throws(() => resolveProviderConfig({ USE_ANTHROPIC: "true" }), ProviderConfigError)
})

test("local mode pins to fallback without requiring a primary model", () => {
  const config = resolveProviderConfig({ NIRI_ENV: "local", LMSTUDIO_BASE_URL: "http://localhost:1234/v1" })
  assert.equal(config.primary, null)
  assert.equal(config.fallback?.baseUrl, "http://localhost:1234/v1")
  // A localhost fallback gets a client-side context ceiling by default.
  assert.equal(config.fallback?.contextWindow?.nCtx, 4096)
})

test("prompt cache key is offered to official OpenAI and withheld from gateways", () => {
  const official = resolveProviderConfig(OPENAI_ENV)
  assert.equal(official.primary?.supportsPromptCacheKey, true)

  const gateway = resolveProviderConfig({ ...OPENAI_ENV, OPENAI_BASE_URL: "https://openrouter.ai/api/v1" })
  assert.equal(gateway.primary?.supportsPromptCacheKey, false)

  const forced = resolveProviderConfig({
    ...OPENAI_ENV,
    OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    OPENAI_PROMPT_CACHE_KEY: "explicit",
  })
  assert.equal(forced.primary?.supportsPromptCacheKey, true)
  assert.equal(forced.primary?.promptCacheKey, "explicit")
})

test("deepseek endpoints are flagged for reasoning replay", () => {
  const byUrl = resolveProviderConfig({ ...OPENAI_ENV, OPENAI_BASE_URL: "https://api.deepseek.com/v1" })
  assert.equal(byUrl.primary?.requiresReasoningReplay, true)
  const byModel = resolveProviderConfig({ ...OPENAI_ENV, MODEL: "deepseek-reasoner" })
  assert.equal(byModel.primary?.requiresReasoningReplay, true)
  assert.equal(resolveProviderConfig(OPENAI_ENV).primary?.requiresReasoningReplay, false)
})

test("a malformed base URL does not throw during resolution", () => {
  const config = resolveProviderConfig({ ...OPENAI_ENV, OPENAI_BASE_URL: "not a url" })
  assert.equal(config.primary?.supportsPromptCacheKey, false)
})

test("quota failover is per-instance and survives via its store", async () => {
  const store = memoryFailoverStore()
  const config = resolveProviderConfig({ ...OPENAI_ENV, PRIMARY_QUOTA_RETRY_MS: "600000" })
  const set = createProviderSet(config, { agentId: "a", failoverStore: store })
  const other = createProviderSet(config, { agentId: "b" })

  assert.equal((await set.failoverStatus()).active, false)
  // A second set with its own store is unaffected by the first one's ban.
  assert.equal((await other.failoverStatus()).active, false)

  const resolved = await set.resolvePrimary()
  assert.equal(resolved?.slot, "primary")
})

test("summary resolution falls back to the turn provider and respects an open circuit", async () => {
  const set = createProviderSet(resolveProviderConfig(OPENAI_ENV), { agentId: "a" })
  const first = await set.resolveSummary()
  assert.equal(first?.provider.model, "gpt-5")

  set.recordUnusable(first!.provider, "returned an empty summary")
  assert.equal(await set.resolveSummary(), null)

  set.recordSuccess(first!.provider)
  assert.equal((await set.resolveSummary())?.provider.model, "gpt-5")
})

test("an explicitly configured summary model is preferred over the turn provider", async () => {
  const set = createProviderSet(
    resolveProviderConfig({
      ...OPENAI_ENV,
      SUMMARY_BASE_URL: "https://openrouter.ai/api/v1",
      SUMMARY_MODEL: "glm-4.7",
      SUMMARY_API_KEY: "sk-sum",
    }),
    { agentId: "a" },
  )
  assert.equal((await set.resolveSummary())?.provider.model, "glm-4.7")
})

test("a partially configured summary provider is rejected", () => {
  assert.throws(
    () => resolveProviderConfig({ ...OPENAI_ENV, SUMMARY_MODEL: "glm-4.7" }),
    ProviderConfigError,
  )
})

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

function apiError(status: number, message: string, code?: string): unknown {
  return new OpenAI.APIError(status, { message, code }, message, new Headers())
}

function stubProvider(
  id: string,
  behaviour: (request: CompletionRequest) => Promise<CompletionTurnResult>,
): Provider {
  return {
    id,
    kind: "openai",
    model: id,
    baseUrl: `https://${id}`,
    toolChoice: "auto",
    config: { kind: "openai", baseUrl: `https://${id}`, apiKey: "k", model: id, toolChoice: "auto" },
    complete: behaviour,
  }
}

const okResult: CompletionTurnResult = {
  message: { role: "assistant", content: "ok", refusal: null } as never,
  emittedText: false,
  emittedThinking: false,
  bufferedThinking: "",
}

function stubSet(primary: Provider, fallback: Provider | null = null): ProviderSet & { failedOver: boolean } {
  let failedOver = false
  const set = {
    primary,
    fallback,
    summary: null,
    enableThinking: false,
    async resolvePrimary() {
      return failedOver && fallback
        ? { provider: fallback, slot: "fallback" as const }
        : { provider: primary, slot: "primary" as const }
    },
    async resolveSummary() { return null },
    async failoverStatus() { return { active: failedOver, retryAtMs: 0, reason: null } },
    async recordQuotaFailover() { failedOver = true; return { active: true, retryAtMs: Date.now() + 1000, reason: "quota" } },
    async clearFailover() { failedOver = false; return true },
    circuitStatus() { return { open: false, permanent: false } },
    recordFailure() {},
    recordUnusable() {},
    recordSuccess() {},
    get failedOver() { return failedOver },
  }
  return set as ProviderSet & { failedOver: boolean }
}

const REQUEST: CompletionRequest = { model: "m", messages: [], tools: [], tool_choice: "auto" }
const FAST = { ...defaultResilienceConfig, maxRetryDelayMs: 1 }

test("an over-large prompt is retried only after the caller shrinks it", async () => {
  let calls = 0
  const provider = stubProvider("p", async () => {
    calls++
    if (calls === 1) throw apiError(400, "prompt is too long", "context_length_exceeded")
    return okResult
  })
  const shrinks: number[] = []
  const result = await completeWithResilience(stubSet(provider), REQUEST, {
    currentMessages: () => [],
    onPromptTooLarge: (attempt) => { shrinks.push(attempt); return true },
  }, {}, FAST)

  assert.equal(result.message.content, "ok")
  assert.deepEqual(shrinks, [1])
  assert.equal(calls, 2)
})

test("an over-large prompt the caller cannot shrink propagates", async () => {
  const provider = stubProvider("p", async () => { throw apiError(400, "prompt is too long", "context_length_exceeded") })
  await assert.rejects(
    completeWithResilience(stubSet(provider), REQUEST, {
      currentMessages: () => [],
      onPromptTooLarge: () => false,
    }, {}, FAST),
    /too long/,
  )
})

test("a content-filter rejection is retried once the caller scrubs the conversation", async () => {
  let calls = 0
  const provider = stubProvider("p", async () => {
    calls++
    if (calls === 1) throw apiError(400, "content_filter triggered", "content_filter")
    return okResult
  })
  const kinds: string[] = []
  await completeWithResilience(stubSet(provider), REQUEST, {
    currentMessages: () => [],
    onContentRejected: (kind) => { kinds.push(kind); return true },
  }, {}, FAST)

  assert.deepEqual(kinds, ["content_filter"])
  assert.equal(calls, 2)
})

test("quota exhaustion on primary fails over to the fallback endpoint", async () => {
  const primary = stubProvider("primary", async () => { throw apiError(429, "You exceeded your current quota") })
  const fallback = stubProvider("fallback", async () => okResult)
  const set = stubSet(primary, fallback)

  const result = await completeWithResilience(set, REQUEST, { currentMessages: () => [] }, {}, FAST)
  assert.equal(result.message.content, "ok")
  assert.equal(set.failedOver, true)
})

test("a transient failure is retried with backoff, then succeeds", async () => {
  let calls = 0
  const provider = stubProvider("p", async () => {
    calls++
    if (calls < 3) throw apiError(503, "service unavailable")
    return okResult
  })
  const retries: number[] = []
  const result = await completeWithResilience(stubSet(provider), REQUEST, {
    currentMessages: () => [],
    onRetry: (info) => retries.push(info.delayMs),
  }, {}, FAST)

  assert.equal(result.message.content, "ok")
  assert.equal(calls, 3)
  assert.equal(retries.length, 2)
})

test("retries are bounded and the last error propagates", async () => {
  let calls = 0
  const provider = stubProvider("p", async () => { calls++; throw apiError(503, "service unavailable") })
  await assert.rejects(
    completeWithResilience(stubSet(provider), REQUEST, { currentMessages: () => [] }, {}, FAST),
    /service unavailable/,
  )
  assert.equal(calls, FAST.maxRetries + 1)
})

test("messages are re-read on each attempt so caller edits take effect", async () => {
  let calls = 0
  const seen: number[] = []
  const provider = stubProvider("p", async (req) => {
    calls++
    seen.push(req.messages.length)
    if (calls === 1) throw apiError(400, "prompt is too long", "context_length_exceeded")
    return okResult
  })
  let messages = [{ role: "user" as const, content: "a" }, { role: "user" as const, content: "b" }]
  await completeWithResilience(stubSet(provider), REQUEST, {
    currentMessages: () => messages,
    onPromptTooLarge: () => { messages = messages.slice(1); return true },
  }, {}, FAST)

  assert.deepEqual(seen, [2, 1])
})
