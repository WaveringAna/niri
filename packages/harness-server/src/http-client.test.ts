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

test("a client that attaches after the worker boots still gets its capabilities", async (t) => {
  let attached = false
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    fetchImpl: async (input) => {
      if (!String(input).endsWith("/health")) throw new Error("unexpected request")
      if (!attached) throw new Error("connection refused")
      return Response.json({
        capabilities: ["python", "shell"],
        workspace: { id: "repo", root: "/repo" },
      })
    },
  })
  t.after(() => client.stop())

  // Worker boots first: the client box is not listening yet.
  await client.start()
  assert.equal(client.status().connected, false)
  assert.equal(client.getCapabilities().includes("python"), false)

  // The tool client dials in afterwards; the background probe must notice.
  attached = true
  const deadline = Date.now() + 5_000
  while (!client.status().connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(client.status().connected, true)
  assert.deepEqual(client.getCapabilities(), ["python", "shell"])
  assert.equal(client.getWorkspace()?.root, "/repo")
})
