import assert from "node:assert/strict"
import test from "node:test"
import { HttpToolClient } from "./http-client.js"

test("direct client calls need no token or pairing handshake", async () => {
  const requests: RequestInit[] = []
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    fetchImpl: async (_input, init) => {
      requests.push(init ?? {})
      const invocation = JSON.parse(String(init?.body)) as { invocationId: string; agentId: string }
      return Response.json({
        type: "tool.result",
        invocationId: invocation.invocationId,
        agentId: invocation.agentId,
        status: "ok",
        output: "hello",
        completedAt: new Date().toISOString(),
      })
    },
  })

  const result = await client.execute({ agentId: "mira", tool: "shell", args: { command: "printf hello" } })
  assert.equal(result.output, "hello")
  assert.equal(new Headers(requests[0]?.headers).has("authorization"), false)
  assert.equal(client.status().connected, true)
})
