import assert from "node:assert/strict"
import test from "node:test"
import { isTransientTransportError, sanitizeMessages, shouldFallback } from "./util.js"

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

test("terminated fetch errors are treated as retryable transport failures", () => {
  const err = new TypeError("terminated")

  assert.equal(isTransientTransportError(err), true)
  assert.equal(shouldFallback(err), true)
})

test("nested undici errors are treated as retryable transport failures", () => {
  const cause = new Error("other side closed")
  const nested = new TypeError("fetch failed") as TypeError & { cause?: unknown }
  nested.cause = cause

  assert.equal(isTransientTransportError(nested), true)
  assert.equal(shouldFallback(nested), true)
})
