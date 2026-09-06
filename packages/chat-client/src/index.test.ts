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
    fetchImpl,
  })

  await client.send("hello")
  const status = await client.getStatus()

  assert.equal(requests[0]?.url, "https://control.example/agents/mira/events")
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { content: "hello", clientId: "cli-1" })
  assert.equal(requests[1]?.url, "https://control.example/agents/mira/status")
  assert.equal(new Headers(requests[0]?.init?.headers).has("authorization"), false)
  assert.equal(new Headers(requests[1]?.init?.headers).has("authorization"), false)
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

test("a failed turn arrives as an error event rather than assistant text", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"stream.event","payload":{"type":"error","text":"401 Incorrect API key"}}\n\n'))
      controller.close()
    },
  })
  const fetchImpl: FetchLike = async () => new Response(body, { status: 200 })
  const client = createChatClient({ baseUrl: "https://control.example", agentId: "mira", fetchImpl })
  const events: unknown[] = []

  await client.stream({ onEvent: (event) => events.push(event) })
  assert.deepEqual(events, [{ type: "error", text: "401 Incorrect API key" }])
})

test("replayed conversation records surface the agent's own replies only", async () => {
  const records = [
    { type: "conversation.message", payload: { role: "user", content: "[wake] triggered by chat\n\nmeow im ana" } },
    { type: "conversation.message", payload: { role: "assistant", content: "hi ana" } },
    { type: "conversation.message", payload: { role: "tool", content: "tool output" } },
  ]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const record of records) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(record)}\n\n`))
      controller.close()
    },
  })
  const fetchImpl: FetchLike = async () => new Response(body, { status: 200 })
  const client = createChatClient({ baseUrl: "https://control.example", agentId: "mira", fetchImpl })
  const events: unknown[] = []

  await client.stream({ onEvent: (event) => events.push(event) })
  assert.deepEqual(events, [{ type: "message", role: "assistant", text: "hi ana" }])
})
