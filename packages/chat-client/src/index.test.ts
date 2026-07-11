import assert from "node:assert/strict"
import test from "node:test"
import { createChatClient, type FetchLike } from "./index.js"

test("control-plane mode scopes chat and status requests to one agent", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({ url: String(input), init })
    if (String(input).endsWith("/status")) {
      return new Response(JSON.stringify({ running: true, idle: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const client = createChatClient({
    baseUrl: "https://control.example/",
    agentId: "mira",
    clientId: "cli-1",
    token: "control-secret",
    fetchImpl,
  })

  await client.send("hello")
  const status = await client.getStatus()

  assert.equal(requests[0]?.url, "https://control.example/agents/mira/events")
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { content: "hello", clientId: "cli-1" })
  assert.equal(requests[1]?.url, "https://control.example/agents/mira/status")
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer control-secret")
  assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), "Bearer control-secret")
  assert.deepEqual(status, { running: true, idle: true })
})

test("control-plane SSE unwraps worker stream.event envelopes", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"stream.event","payload":{"type":"text","text":"hiya"}}\n\n'))
      controller.close()
    },
  })
  const fetchImpl: FetchLike = async () => new Response(body, { status: 200 })
  const client = createChatClient({ baseUrl: "https://control.example", agentId: "mira", fetchImpl })
  const events: unknown[] = []

  await client.stream({ onEvent: (event) => events.push(event) })
  assert.deepEqual(events, [{ type: "text", text: "hiya" }])
})
