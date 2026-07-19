import assert from "node:assert/strict"
import test from "node:test"
import type { LoopState } from "./types"
import { __completionTest } from "./loop-completion"
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

test("prompt cache keys are stable for official OpenAI and the local Codex bridge", () => {
  const previousEnabled = process.env.CODEX_BRIDGE_ENABLED
  const previousPort = process.env.CODEX_BRIDGE_PORT
  const previousKey = process.env.OPENAI_PROMPT_CACHE_KEY
  delete process.env.OPENAI_PROMPT_CACHE_KEY
  process.env.CODEX_BRIDGE_ENABLED = "true"
  process.env.CODEX_BRIDGE_PORT = "8001"
  try {
    assert.deepEqual(
      __completionTest.promptCacheRequestExtras("https://api.openai.com/v1", "primary"),
      { prompt_cache_key: `${AGENT_ID}:primary` },
    )
    assert.deepEqual(
      __completionTest.promptCacheRequestExtras("http://127.0.0.1:8001/v1", "primary"),
      { prompt_cache_key: `${AGENT_ID}:primary` },
    )
    assert.deepEqual(__completionTest.promptCacheRequestExtras("https://openrouter.ai/api/v1", "fallback"), {})
  } finally {
    if (previousEnabled === undefined) delete process.env.CODEX_BRIDGE_ENABLED
    else process.env.CODEX_BRIDGE_ENABLED = previousEnabled
    if (previousPort === undefined) delete process.env.CODEX_BRIDGE_PORT
    else process.env.CODEX_BRIDGE_PORT = previousPort
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
    memoryRecallCooldowns: {},
    memoryRecallTurn: 1,
    memoryRecallPending: true,
    shutdownRequested: false,
    turnInFlight: false,
  }

  const result = __completionTest.quarantineLatestIncomingForContentFilter(state)

  assert.deepEqual(result, { redacted: true, index: 0 })
  assert.equal(state.memoryRecallPending, false)
  assert.equal(state.conversation.length, 2)
  assert.match(String(state.conversation[0]?.content), /\[discord\/dm\] @ana/)
  assert.match(String(state.conversation[0]?.content), /source_item_id: 456/)
  assert.doesNotMatch(String(state.conversation[0]?.content), /blocked body text/)
  assert.match(String(state.conversation[1]?.content), /blocked by z\.ai/)
})
