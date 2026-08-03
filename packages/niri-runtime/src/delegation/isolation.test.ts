import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { LoopState } from "../runner/types"

test("worker usage and client tools do not emit as niri activity", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-delegation-isolation-test-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  process.env.NIRI_HOME = home
  process.env.NIRI_ENV = "local"

  const { initDb, startConversation } = await import("../db.js")
  const { initMetricsDb } = await import("../metrics.js")
  const { subscribe } = await import("../stream.js")
  const { applyUsage } = await import("../runner/loop-completion.js")
  const { buildToolHandlers } = await import("../runner/loop-tool-registry.js")
  initDb()
  initMetricsDb()

  const state: LoopState = {
    conversation: [],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
  }
  const events: unknown[] = []
  const unsubscribe = subscribe((event) => events.push(event))
  t.after(unsubscribe)

  const beforeUsage = events.length
  applyUsage(
    state,
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    {},
    { emitEvent: false },
  )
  assert.equal(events.length, beforeUsage)

  const clientTools = {
    getCapabilities: () => ["read_file"],
    getWorkspace: () => ({ id: "test", root: home }),
    execute: async () => ({
      type: "tool.result",
      invocationId: "invocation-1",
      agentId: "test",
      status: "ok",
      output: "worker-only output",
      completedAt: new Date().toISOString(),
    }),
  }
  const handlers = buildToolHandlers({ clientTools } as never, { emitClientToolEvents: false })
  const beforeTool = events.length
  await handlers.read_file?.({
    convId: startConversation("delegation:test", new Date().toISOString()),
    state,
    hooks: { clientTools } as never,
    call: {
      id: "call-1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) },
    },
    args: { path: "notes.txt" },
  })
  assert.equal(events.length, beforeTool)
  assert.equal(state.conversation.at(-1)?.role, "tool")
})
