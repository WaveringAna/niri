import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { ClientToolHost } from "@mira/harness-core"
import type { ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@mira/harness-protocol"
import { RemoteToolClient } from "./remote.js"

class FakeHost implements ClientToolHost {
  executions = 0
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getCapabilities(): ToolCapability[] { return ["shell"] }
  getWorkspace(): WorkspaceDescriptor { return { id: "workspace", root: "/workspace" } }
  async execute(invocation: ToolInvocation): Promise<ClientToolResult> {
    this.executions += 1
    return {
      type: "tool.result",
      invocationId: invocation.invocationId,
      agentId: invocation.agentId,
      clientId: invocation.clientId,
      leaseId: invocation.leaseId,
      status: "ok",
      output: "executed",
      completedAt: new Date().toISOString(),
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function toolCall(
  leaseId: string,
  deadlineAt = new Date(Date.now() + 10_000).toISOString(),
  issuedAt = new Date().toISOString(),
): ToolInvocation {
  return {
    type: "tool.call",
    invocationId: "invocation-1",
    agentId: "agent",
    clientId: "client",
    leaseId,
    tool: "shell",
    args: { command: "do work" },
    issuedAt,
    deadlineAt,
  }
}

test("an expired invocation is reported without executing it", async () => {
  const host = new FakeHost()
  const results: ClientToolResult[] = []
  let client: RemoteToolClient
  const fetchImpl: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname
    if (pathname.endsWith("/hello")) return json({ agentId: "agent", clientId: "client", leaseId: "lease", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    if (pathname.endsWith("/poll")) {
      return json(toolCall("lease", new Date(Date.now() - 1).toISOString(), new Date(Date.now() - 2_000).toISOString()))
    }
    if (pathname.endsWith("/results")) {
      results.push(JSON.parse(String(init?.body)) as ClientToolResult)
      client.stop()
      return json({ ok: true })
    }
    throw new Error(`unexpected path ${pathname}`)
  }
  client = new RemoteToolClient({ endpoint: "http://server/client", agentId: "agent", clientId: "client", token: "token", host, fetchImpl })
  await client.start()
  assert.equal(host.executions, 0)
  assert.equal(results[0]?.status, "cancelled")
})

test("a lost result response replays the journaled result without re-execution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "harness-remote-journal-"))
  const journalPath = path.join(directory, "journal.json")
  const host = new FakeHost()
  let helloCount = 0
  let resultAttempts = 0
  let client: RemoteToolClient
  const uploaded: ClientToolResult[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname
    if (pathname.endsWith("/hello")) {
      helloCount += 1
      return json({ agentId: "agent", clientId: "client", leaseId: `lease-${helloCount}`, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    if (pathname.endsWith("/poll")) return json(toolCall(`lease-${helloCount}`))
    if (pathname.endsWith("/results")) {
      resultAttempts += 1
      uploaded.push(JSON.parse(String(init?.body)) as ClientToolResult)
      const mode = (await fs.stat(journalPath)).mode & 0o777
      assert.equal(mode, 0o600)
      if (resultAttempts === 1) throw new Error("connection dropped after upload")
      client.stop()
      return json({ ok: true })
    }
    throw new Error(`unexpected path ${pathname}`)
  }
  client = new RemoteToolClient({
    endpoint: "http://server/client",
    agentId: "agent",
    clientId: "client",
    token: "token",
    host,
    fetchImpl,
    journalPath,
    reconnectDelayMs: 100,
  })
  try {
    await client.start()
    assert.equal(host.executions, 1)
    assert.equal(helloCount, 2)
    assert.equal(resultAttempts, 2)
    assert.equal(uploaded[1]?.leaseId, "lease-2")
    assert.deepEqual(JSON.parse(await fs.readFile(journalPath, "utf8")), {})
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a corrupt journal fails closed before any tool can execute", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "harness-remote-corrupt-"))
  const journalPath = path.join(directory, "journal.json")
  await fs.writeFile(journalPath, "{truncated", "utf8")
  const host = new FakeHost()
  const client = new RemoteToolClient({
    endpoint: "http://server/client",
    agentId: "agent",
    clientId: "client",
    token: "token",
    host,
    journalPath,
    fetchImpl: async () => { throw new Error("network must not be reached") },
  })
  try {
    await assert.rejects(() => client.start(), /tool journal is not valid JSON/)
    assert.equal(host.executions, 0)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
