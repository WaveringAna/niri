import assert from "node:assert/strict"
import test from "node:test"
import {
  addCompletionUsage,
  emptyDelegatedTokenUsage,
  formatDelegatedTokenUsage,
  totalDelegatedTokens,
} from "./usage.js"

test("delegated usage separates cache reads from uncached input and output", () => {
  let usage = emptyDelegatedTokenUsage()
  usage = addCompletionUsage(usage, {
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 80 },
    completion_tokens: 7,
    total_tokens: 107,
  })
  usage = addCompletionUsage(usage, {
    prompt_tokens: 40,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens: 3,
    total_tokens: 43,
  })

  assert.deepEqual(usage, {
    cacheReadTokens: 90,
    uncachedInputTokens: 50,
    outputTokens: 10,
  })
  assert.equal(totalDelegatedTokens(usage), 150)
  assert.equal(formatDelegatedTokenUsage(usage), "90 cache read, 50 uncached input, 10 output tokens")
})

test("delegated usage treats absent or invalid cache details as uncached input", () => {
  const usage = addCompletionUsage(emptyDelegatedTokenUsage(), {
    prompt_tokens: 12,
    prompt_tokens_details: { cached_tokens: 99 },
    completion_tokens: 2,
    total_tokens: 14,
  })
  assert.deepEqual(usage, {
    cacheReadTokens: 12,
    uncachedInputTokens: 0,
    outputTokens: 2,
  })
})
