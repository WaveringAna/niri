import assert from "node:assert/strict"
import test from "node:test"
import { ClientToolBroker } from "./client-broker.js"

const hello = {
  protocol: "harness-tool/v1" as const,
  agentId: "mira",
  clientId: "mira-macbook",
  capabilities: ["shell", "read_file", "edit_file", "image_tool"] as const,
  workspace: {
    id: "mira",
    root: "/Users/mira/Developer/project",
    imageRoot: "/Users/mira/Developer/project/images",
    platform: "darwin",
    persistentShell: true,
  },
}

test("broker only exposes authenticated attached-client capabilities", () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "pairing-secret" })

  assert.equal(broker.isAuthorized("Bearer pairing-secret"), true)
  assert.equal(broker.isAuthorized("pairing-secret"), false)
  assert.equal(broker.isAuthorized("Bearer wrong"), false)
  assert.deepEqual(broker.getCapabilities(), [])

  broker.register(hello)
  assert.deepEqual(broker.getCapabilities(), ["shell", "read_file", "edit_file", "image_tool"])
  assert.equal(broker.getWorkspace()?.root, hello.workspace.root)
})

test("broker delivers a client invocation and resolves only its matching result", async () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "pairing-secret" })
  const lease = broker.register(hello)

  const execution = broker.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "pwd" },
    timeoutMs: 5_000,
  })
  const invocation = await broker.poll({ clientId: hello.clientId, leaseId: lease.leaseId, timeoutMs: 1_000 })

  assert.equal(invocation.type, "tool.call")
  if (invocation.type !== "tool.call") throw new Error("expected tool call")
  assert.equal(invocation.tool, "shell")
  assert.deepEqual(invocation.args, { command: "pwd" })

  broker.acceptResult({
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: "mira",
    clientId: hello.clientId,
    leaseId: lease.leaseId,
    status: "ok",
    output: "/Users/mira/Developer/project",
    completedAt: new Date().toISOString(),
  })

  const result = await execution
  assert.equal(result.status, "ok")
  assert.equal(result.output, "/Users/mira/Developer/project")
})

test("broker replays an in-flight call to a replacement lease without executing on the server", async () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "pairing-secret" })
  const firstLease = broker.register(hello)
  const execution = broker.execute({
    agentId: "mira",
    tool: "edit_file",
    args: { path: "notes.md", old_text: "a", new_text: "b" },
    timeoutMs: 5_000,
  })

  const first = await broker.poll({ clientId: hello.clientId, leaseId: firstLease.leaseId, timeoutMs: 1_000 })
  assert.equal(first.type, "tool.call")
  if (first.type !== "tool.call") throw new Error("expected tool call")

  const replacementLease = broker.register(hello)
  assert.notEqual(replacementLease.leaseId, firstLease.leaseId)
  const replay = await broker.poll({ clientId: hello.clientId, leaseId: replacementLease.leaseId, timeoutMs: 1_000 })
  assert.equal(replay.type, "tool.call")
  if (replay.type !== "tool.call") throw new Error("expected replay")
  assert.equal(replay.invocationId, first.invocationId)
  assert.equal(replay.leaseId, replacementLease.leaseId)

  broker.acceptResult({
    type: "tool.result",
    invocationId: replay.invocationId,
    agentId: "mira",
    clientId: hello.clientId,
    leaseId: replacementLease.leaseId,
    status: "unknown",
    output: "error: client restarted while command outcome was unknown",
    completedAt: new Date().toISOString(),
  })
  const result = await execution
  assert.equal(result.status, "unknown")
})

test("broker never substitutes a server filesystem when no client is attached", async () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "pairing-secret" })
  const result = await broker.execute({
    agentId: "mira",
    tool: "read_file",
    args: { path: "/etc/passwd" },
  })
  assert.equal(result.status, "error")
  assert.match(result.output ?? "", /no authenticated client workspace/i)
})

test("a second client cannot replace an active client or inherit its invocation", async () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "pairing-secret" })
  broker.register(hello)
  const execution = broker.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "sleep 1" },
    timeoutMs: 1_000,
  })

  assert.throws(
    () => broker.register({ ...hello, clientId: "other-client" }),
    /already has an attached tool client/,
  )
  assert.equal(broker.status().pendingInvocations, 1)
  broker.detach({ clientId: hello.clientId, leaseId: broker.register(hello).leaseId })
  assert.equal((await execution).status, "unknown")
})

test("a matching in-flight result remains valid after the heartbeat lease expires", async () => {
  const broker = new ClientToolBroker({
    agentId: "mira",
    token: "pairing-secret",
    leaseTtlMs: 100,
    activeClientTtlMs: 100,
  })
  const lease = broker.register(hello)
  const execution = broker.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "slow command" },
    timeoutMs: 1_000,
  })
  const invocation = await broker.poll({ clientId: hello.clientId, leaseId: lease.leaseId, timeoutMs: 1_000 })
  if (invocation.type !== "tool.call") throw new Error("expected tool call")
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(broker.status().connected, false)

  broker.acceptResult({
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: "mira",
    clientId: hello.clientId,
    leaseId: lease.leaseId,
    status: "ok",
    output: "finished",
    completedAt: new Date().toISOString(),
  })
  assert.equal((await execution).output, "finished")
  assert.equal(broker.status().connected, true)
})

test("lease expiry does not let a different client steal an in-flight call", async () => {
  const broker = new ClientToolBroker({
    agentId: "mira",
    token: "pairing-secret",
    leaseTtlMs: 100,
    activeClientTtlMs: 100,
  })
  const lease = broker.register(hello)
  const execution = broker.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "slow command" },
    timeoutMs: 1_000,
  })
  const invocation = await broker.poll({ clientId: hello.clientId, leaseId: lease.leaseId, timeoutMs: 1_000 })
  if (invocation.type !== "tool.call") throw new Error("expected tool call")
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.throws(
    () => broker.register({ ...hello, clientId: "other-client" }),
    /already has an attached tool client/,
  )
  broker.acceptResult({
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: "mira",
    clientId: hello.clientId,
    leaseId: lease.leaseId,
    status: "ok",
    output: "finished",
    completedAt: new Date().toISOString(),
  })
  assert.equal((await execution).status, "ok")
})
