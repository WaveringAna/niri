import assert from "node:assert/strict"
import test from "node:test"
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
