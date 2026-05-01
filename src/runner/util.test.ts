import assert from "node:assert/strict"
import test from "node:test"
import { sanitizeMessages } from "./util.js"

test("sanitizeMessages backfills empty reasoning_content for assistant history", () => {
  const messages = sanitizeMessages([
    {
      role: "assistant",
      content: "plain reply",
      refusal: null,
    },
    {
      role: "assistant",
      content: "reply with reasoning",
      refusal: null,
      reasoning_content: "thinking...",
    },
  ])

  const assistant = messages[0] as (typeof messages)[number] & { reasoning_content?: string }
  assert.equal(assistant.role, "assistant")
  assert.equal(assistant.reasoning_content, "")
})
