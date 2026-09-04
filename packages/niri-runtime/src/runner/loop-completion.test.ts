import assert from "node:assert/strict"
import test from "node:test"
import type { LoopState } from "./types"
import { __completionTest } from "./loop-completion"
import { recallState } from "./runtime"
import { AGENT_ID } from "../agent-config"

test("consumeCompletionStream preserves reasoning_content on assistant messages", async () => {
  async function* stream() {
    yield {
      id: "chunk_1",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "thinking...",
          },
          finish_reason: null,
        },
      ],
    }
    yield {
      id: "chunk_2",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            content: "hello",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: {
          cached_tokens: 8,
          cache_write_tokens: 2,
        },
      },
    }
  }

  const result = await __completionTest.consumeCompletionStream(stream() as never)
  const message = result.message as typeof result.message & { reasoning_content?: string }

  assert.equal(message.content, "hello")
  assert.equal(message.reasoning_content, "thinking...")
  assert.equal(result.bufferedThinking, "thinking...")
  assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 8)
  assert.equal(result.usage?.prompt_tokens_details?.cache_write_tokens, 2)
})

test("pathological compaction recollections are rejected before reaching chat", () => {
  assert.equal(
    __completionTest.isPathologicalCompactionRecollection(
      "i want to carry forward one specific feeling and the unfinished work attached to it.",
    ),
    false,
  )
  assert.equal(
    __completionTest.isPathologicalCompactionRecollection(
      Array.from({ length: 6 }, () => "memory_write. journal/2026-07-27.md. append.").join("\n"),
    ),
    true,
  )
  assert.equal(__completionTest.isPathologicalCompactionRecollection("x".repeat(20_001)), true)
})

test("prompt cache keys are stable for official OpenAI endpoints", () => {
  const previousKey = process.env.OPENAI_PROMPT_CACHE_KEY
  delete process.env.OPENAI_PROMPT_CACHE_KEY
  try {
    assert.deepEqual(
      __completionTest.promptCacheRequestExtras("https://api.openai.com/v1", "primary"),
      { prompt_cache_key: `${AGENT_ID}:primary` },
    )
    assert.deepEqual(__completionTest.promptCacheRequestExtras("https://openrouter.ai/api/v1", "fallback"), {})
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_PROMPT_CACHE_KEY
    else process.env.OPENAI_PROMPT_CACHE_KEY = previousKey
  }
})

test("content-filter recovery redacts discord body but keeps routing context", () => {
  const state: LoopState = {
    conversation: [
      {
        role: "user",
        content: [
          "[incoming — discord]",
          "[discord/dm] @ana\ncontext: DM 123\nmessage_id: 456\nsource_item_id: 456\naction: reply if needed",
          "blocked body text",
        ].join("\n\n"),
      },
    ],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    shutdownRequested: false,
    turnInFlight: false,
    extras: new Map(),
  }

  const result = __completionTest.quarantineLatestIncomingForContentFilter(state)

  assert.deepEqual(result, { redacted: true, index: 0 })
  assert.equal(recallState(state).pending, false)
  assert.equal(state.conversation.length, 2)
  assert.match(String(state.conversation[0]?.content), /\[discord\/dm\] @ana/)
  assert.match(String(state.conversation[0]?.content), /source_item_id: 456/)
  assert.doesNotMatch(String(state.conversation[0]?.content), /blocked body text/)
  assert.match(String(state.conversation[1]?.content), /blocked by z\.ai/)
})

test("a provider that rejects a forced tool_choice is only asked once per process", () => {
  const { effectiveToolChoice, rememberForcedToolChoiceRejection, resetForcedToolChoiceMemory } = __completionTest
  resetForcedToolChoiceMemory()
  try {
    assert.equal(effectiveToolChoice("https://api.deepseek.com", "deepseek-v4-flash", "required"), "required")

    rememberForcedToolChoiceRejection("https://api.deepseek.com", "deepseek-v4-flash")
    assert.equal(effectiveToolChoice("https://api.deepseek.com", "deepseek-v4-flash", "required"), "auto")

    // The downgrade is scoped to the endpoint+model that actually refused it.
    assert.equal(effectiveToolChoice("https://api.deepseek.com", "deepseek-v4-other", "required"), "required")
    assert.equal(effectiveToolChoice("https://openrouter.ai/api/v1", "deepseek-v4-flash", "required"), "required")
    // "none" is a deliberate no-tools turn, not a forced one, so it is never rewritten.
    assert.equal(effectiveToolChoice("https://api.deepseek.com", "deepseek-v4-flash", "none"), "none")
  } finally {
    resetForcedToolChoiceMemory()
  }
})
