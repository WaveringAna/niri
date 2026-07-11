import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { NodeToolHost } from "./host.js"
import type { ClientToolName, ToolInvocation } from "@mira/harness-protocol"

function invocation(tool: ClientToolName, args: Record<string, unknown>): ToolInvocation {
  return {
    type: "tool.call",
    invocationId: `${tool}-1`,
    agentId: "agent",
    clientId: "client",
    leaseId: "lease",
    tool,
    args,
    issuedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
  }
}

test("Docker mode requires both container name and user", () => {
  assert.throws(
    () => new NodeToolHost({ runtime: { containerName: "workspace-container" } }),
    /container name and container user must be configured together/,
  )
})

test("the advertised workspace is the persistent shell's initial directory", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-cwd-"))
  const realWorkspace = await fs.realpath(workspace)
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("shell", { command: "pwd -P" }))
    assert.equal(result.status, "ok")
    assert.equal(result.output, realWorkspace)
    assert.equal(host.getWorkspace().root, realWorkspace)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("an unsuccessful exact edit is a tool error", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-edit-"))
  const file = path.join(workspace, "notes.md")
  await fs.writeFile(file, "one\n", "utf8")
  const host = new NodeToolHost({ capabilities: ["edit_file"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("edit_file", { path: file, old_text: "missing", new_text: "two" }))
    assert.equal(result.status, "error")
    assert.match(result.output ?? "", /old_text not found/)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("native edits replace atomically and preserve file permissions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-atomic-edit-"))
  const file = path.join(workspace, "notes.md")
  await fs.writeFile(file, "one\n", { mode: 0o640 })
  const host = new NodeToolHost({ capabilities: ["edit_file"], workspace: { root: workspace } })
  try {
    const result = await host.execute(invocation("edit_file", { path: file, old_text: "one", new_text: "two" }))
    assert.equal(result.status, "ok")
    assert.equal(await fs.readFile(file, "utf8"), "two\n")
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
    assert.deepEqual((await fs.readdir(workspace)).filter((name) => name.endsWith(".tmp")), [])
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("a second host makes the previous process-global runtime fail closed", async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-first-"))
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-second-"))
  await fs.writeFile(path.join(firstRoot, "marker.txt"), "first")
  await fs.writeFile(path.join(secondRoot, "marker.txt"), "second")
  const first = new NodeToolHost({ capabilities: ["read_file"], workspace: { root: firstRoot } })
  const second = new NodeToolHost({ capabilities: ["read_file"], workspace: { root: secondRoot } })
  try {
    const stale = await first.execute(invocation("read_file", { path: "marker.txt" }))
    const current = await second.execute(invocation("read_file", { path: "marker.txt" }))
    assert.equal(stale.status, "error")
    assert.match(stale.output ?? "", /superseded/)
    assert.match(current.output ?? "", /second/)
  } finally {
    await first.stop()
    await second.stop()
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ])
  }
})

test("the model shell does not inherit harness daemon secrets", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-env-"))
  process.env.NIRI_CONTROL_TOKEN = "control-probe"
  process.env.NIRI_LOCAL_AGENTS_JSON = "sibling-probe"
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { root: workspace } })
  try {
    const result = await host.execute(invocation("shell", {
      command: "printf '%s|%s' \"${NIRI_CONTROL_TOKEN-}\" \"${NIRI_LOCAL_AGENTS_JSON-}\"",
    }))
    assert.equal(result.status, "ok")
    assert.equal(result.output, "|")
  } finally {
    delete process.env.NIRI_CONTROL_TOKEN
    delete process.env.NIRI_LOCAL_AGENTS_JSON
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
