import assert from "node:assert/strict"
import test from "node:test"
import type { LoopState } from "./types"
import { __completionTest } from "./loop-completion"

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
      },
    }
  }

  const result = await __completionTest.consumeCompletionStream(stream() as never)
  const message = result.message as typeof result.message & { reasoning_content?: string }

  assert.equal(message.content, "hello")
  assert.equal(message.reasoning_content, "thinking...")
  assert.equal(result.bufferedThinking, "thinking...")
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
