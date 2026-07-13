import assert from "node:assert/strict"
import test from "node:test"
import type { ClientToolHost } from "@mira/harness-core"
import type { ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@mira/harness-protocol"
import { ToolClientHttpServer } from "./http-server.js"

class FakeHost implements ClientToolHost {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getCapabilities(): ToolCapability[] { return ["shell"] }
  getWorkspace(): WorkspaceDescriptor { return { id: "test", root: "/workspace" } }
  async execute(invocation: ToolInvocation): Promise<ClientToolResult> {
    return {
      type: "tool.result",
      invocationId: invocation.invocationId,
      agentId: invocation.agentId,
      status: "ok",
      output: String(invocation.args.command ?? ""),
      completedAt: new Date().toISOString(),
    }
  }
}

test("client serves health and tools without authentication", async () => {
  const server = new ToolClientHttpServer({ host: new FakeHost(), listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  try {
    const health = await fetch(`${address.url}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual((await health.json() as { capabilities: string[] }).capabilities, ["shell"])

    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: "one",
      agentId: "mira",
      tool: "shell",
      args: { command: "hello" },
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }
    const response = await fetch(`${address.url}/tools/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invocation),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { output: string }).output, "hello")
  } finally {
    await server.stop()
  }
})
