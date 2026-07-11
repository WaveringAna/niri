import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { createCodexBridgeServer, __codexBridgeTest } from "./codex-bridge"

test("maps OpenAI chat history and tools to Codex Responses input", () => {
  const mapped = __codexBridgeTest.mapMessages([
    { role: "system", content: "be precise" },
    { role: "user", content: "hello" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ])
  assert.equal(mapped.instructions, "be precise")
  assert.deepEqual(mapped.input[0], { role: "user", content: [{ type: "input_text", text: "hello" }] })
  assert.equal(mapped.input[1].type, "function_call")
  assert.equal(mapped.input[2].type, "function_call_output")
})

test("bridge uses Codex credentials and translates a completion", async () => {
  const dir = fs.mkdtempSync("/tmp/niri-codex-bridge-")
  const authPath = `${dir}/auth.json`
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "header.payload.signature", account_id: "acct_test" } }))
  let observed: { url?: string; init?: RequestInit } = {}
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    observed = { url: String(url), init }
    const response = { id: "resp_1", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "meow" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response })}`,
      "data: [DONE]",
      "",
    ].join("\n\n")
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  const app = createCodexBridgeServer({ authPath, fetchImpl })
  const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "Codex", messages: [{ role: "user", content: "hi" }] } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().choices[0].message.content, "meow")
  assert.equal(observed.url, "https://chatgpt.com/backend-api/codex/responses")
  assert.equal(new Headers(observed.init?.headers).get("chatgpt-account-id"), "acct_test")
  const sent = JSON.parse(String(observed.init?.body))
  assert.equal(sent.model, "gpt-5.6-sol")
  assert.equal(sent.input[0].content[0].text, "hi")
  await app.close()
})

test("bridge accepts conversations larger than Fastify's default one megabyte limit", async () => {
  const dir = fs.mkdtempSync("/tmp/niri-codex-bridge-large-")
  const authPath = `${dir}/auth.json`
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "header.payload.signature" } }))
  let upstreamBytes = 0
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    upstreamBytes = Buffer.byteLength(String(init?.body))
    const response = { id: "resp_large", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const sse = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  const app = createCodexBridgeServer({ authPath, fetchImpl })
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "Codex", messages: [{ role: "user", content: "x".repeat(1_200_000) }] },
  })
  assert.equal(response.statusCode, 200)
  assert.ok(upstreamBytes > 1_000_000)
  await app.close()
})
