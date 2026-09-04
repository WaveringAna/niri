import assert from "node:assert/strict"
import test from "node:test"
import { __loopTest } from "./loop"
import type { Message } from "../types"
import type { LoopHooks, LoopState } from "./types"

const testClientTools = {
  getCapabilities: () => [],
  getWorkspace: () => null,
  execute: async () => {
    throw new Error("unexpected client tool execution")
  },
}

function makeState(): LoopState {
  return {
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
}

test("implicit continuation waits ten minutes and injects an external event", async () => {
  const state = makeState()
  const calls: string[] = []
  const event = {
    source: "chat" as const,
    triggeredAt: "2026-05-01T04:40:00.000Z",
    content: "still here",
    raw: {},
  }
  const hooks: LoopHooks = {
    clientTools: testClientTools,
    getTools: () => [],
    waitForEvent: async () => {
      throw new Error("unexpected indefinite wait")
    },
    waitForEventWithTimeout: async (timeoutMs) => {
      calls.push(`wait:${timeoutMs}`)
      return event
    },
    injectIncomingEvent: (convId, incoming) => {
      calls.push(`inject:${incoming.content}`)
      assert.equal(convId, 42)
      assert.equal(incoming, event)
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {
      throw new Error("event delivery should not synthesize a message")
    },
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  }

  await __loopTest.waitForImplicitContinuation(42, state, hooks)

  assert.deepEqual(calls, ["wait:600000", "inject:still here"])
  assert.deepEqual(state.conversation, [])
})

test("implicit continuation resumes with an in-band message after timeout", async () => {
  const state = makeState()
  let saved = false
  const hooks: LoopHooks = {
    clientTools: testClientTools,
    getTools: () => [],
    waitForEvent: async () => {
      throw new Error("unexpected indefinite wait")
    },
    waitForEventWithTimeout: async (timeoutMs) => {
      assert.equal(timeoutMs, 600_000)
      return null
    },
    injectIncomingEvent: () => {
      throw new Error("unexpected event")
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {
      saved = true
    },
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  }

  await __loopTest.waitForImplicitContinuation(42, state, hooks)

  assert.equal(saved, true)
  assert.equal(state.conversation.length, 1)
  assert.equal(state.conversation[0]?.role, "user")
  assert.match(String(state.conversation[0]?.content), /ten-minute wait elapsed/)
})

test("compaction pruning archives large old workspace output while preserving social tools", () => {
  const oldWorkspaceOutput = "workspace-result\n" + "w".repeat(12_000)
  const oldMemoryOutput = "memory-result\n" + "m".repeat(12_000)
  const messages: Message[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_python", type: "function", function: { name: "python", arguments: "{}" } },
        { id: "call_memory", type: "function", function: { name: "memory_read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_python", content: oldWorkspaceOutput },
    { role: "tool", tool_call_id: "call_memory", content: oldMemoryOutput },
    { role: "user", content: "recent context\n" + "r".repeat(40_000) },
  ]

  const result = __loopTest.pruneToolOutputsForCompaction(messages)

  assert.equal(result.prunedMessages, 1)
  assert.ok(result.removedChars > 8_000)
  assert.match(String(result.messages[1]?.content), /tool output pruned during compaction/)
  assert.match(String(result.messages[1]?.content), /workspace-result/)
  assert.equal(result.messages[2]?.content, oldMemoryOutput)
  assert.equal(messages[1]?.content, oldWorkspaceOutput)
})

test("small follow-up compactions wait for a meaningful batch", () => {
  assert.equal(__loopTest.shouldDeferSmallFollowUpCompaction(true, 8, 90_000), true)
  assert.equal(__loopTest.shouldDeferSmallFollowUpCompaction(true, 24, 90_000), false)
  assert.equal(__loopTest.shouldDeferSmallFollowUpCompaction(false, 8, 90_000), false)
})

test("hard observed context pressure permits a small follow-up compaction", () => {
  assert.equal(__loopTest.shouldDeferSmallFollowUpCompaction(true, 8, 114_999), true)
  assert.equal(__loopTest.shouldDeferSmallFollowUpCompaction(true, 8, 115_000), false)
})
