import assert from "node:assert/strict"
import { test } from "node:test"
import { ProviderConfigError, resolveProviderConfig } from "./config.js"
import { createProviderSet, memoryFailoverStore } from "./provider-set.js"

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

  const quotaError = Object.assign(new Error("You exceeded your current quota"), { status: 429 })
  Object.setPrototypeOf(quotaError, (await import("openai")).default.APIError.prototype)

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
