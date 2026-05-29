import assert from "node:assert/strict"
import test from "node:test"
import { envHeaderValue, openAIHeaders, openAIUserAgent } from "./openai-headers"

test("envHeaderValue trims blank env header values", () => {
  assert.equal(envHeaderValue(undefined), undefined)
  assert.equal(envHeaderValue("   "), undefined)
  assert.equal(envHeaderValue(" niri/1.0 "), "niri/1.0")
})

test("openAIUserAgent uses provider-specific env before the global default", (t) => {
  const previous = process.env.OPENAI_USER_AGENT
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_USER_AGENT
    else process.env.OPENAI_USER_AGENT = previous
  })

  process.env.OPENAI_USER_AGENT = " global-agent/1.0 "

  assert.equal(openAIUserAgent(), "global-agent/1.0")
  assert.equal(openAIUserAgent(" provider-agent/2.0 "), "provider-agent/2.0")
  assert.equal(openAIUserAgent(" "), "global-agent/1.0")
})

test("openAIHeaders omits empty values and returns undefined when empty", () => {
  assert.equal(openAIHeaders([["User-Agent", " "]]), undefined)
  assert.deepEqual(openAIHeaders([["User-Agent", " niri/1.0 "]]), { "User-Agent": "niri/1.0" })
})
