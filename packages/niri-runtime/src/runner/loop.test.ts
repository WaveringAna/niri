import assert from "node:assert/strict"
import test from "node:test"
import { __loopTest } from "./loop"
import type { Message } from "../types"
import type { LoopState } from "./types"

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

test("applyDiscordSendNudge appends a follow-up user nudge for unsent Discord replies", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    {
      role: "user",
      content: "[user/discord] [discord/dm] hey are you there",
    },
    {
      role: "assistant",
      content: "yeah, i'm here",
    },
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 1)
  assert.match(String(state.conversation[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires for [discord batch] envelopes (space, not slash)", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    {
      role: "user",
      content: "[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z\n@meowskullz: hi\n@meowskullz: u there",
    },
    {
      role: "assistant",
      content: "yeah hi",
    },
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 1)
  assert.match(String(state.conversation[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires after a harness restart when the discord event is pre-turn context", () => {
  const state = makeState()
  state.conversation.push(
    {
      role: "user",
      content: "[harness restarted — discord @ 2026-05-01T04:30:00.000Z]\n\n[discord/dm] hi starfish",
    },
    {
      role: "assistant",
      content: "i keep getting bounced by harness restarts sorry ^^ still here though! what's up?",
    },
  )

  const turnStart = 1
  const turnMessages: Message[] = [state.conversation[1]!]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages, turnStart)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 3)
  assert.match(String(state.conversation[2]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge does not fire when discord_send was already called", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    {
      role: "user",
      content: "[user/discord] [discord/channel] can you reply",
    },
    {
      role: "assistant",
      content: "sending now",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "discord_send",
            arguments: "{\"channel_id\":\"1\",\"content\":\"sending now\"}",
          },
        },
      ],
    },
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, false)
  assert.equal(state.conversation.length, 0)
})

test("applyLoopGuardNudge appends an in-band user nudge and saves", async () => {
  const state = makeState()
  let saved = false

  await __loopTest.applyLoopGuardNudge(
    state,
    {
      clientTools: testClientTools,
      getTools: () => [],
      waitForEvent: async () => {
        throw new Error("unexpected wait")
      },
      waitForEventWithTimeout: async () => null,
      injectIncomingEvent: () => {},
      flushDeferredEvents: () => {},
      clearSession: async () => {},
      saveSession: async () => {
        saved = true
      },
      saveShutdownSnapshot: async () => {},
      shouldShutdown: () => false,
      resolveShutdown: () => {},
    },
    "loop guard tripped after 120 turns",
  )

  assert.equal(saved, true)
  assert.equal(state.conversation.length, 1)
  assert.equal(state.conversation[0]?.role, "user")
  assert.match(String(state.conversation[0]?.content), /loop guard tripped after 120 turns/i)
})

test("waitForNextEvent waits for and injects the next external event", async () => {
  const calls: string[] = []
  const event = {
    source: "chat" as const,
    triggeredAt: "2026-05-01T04:40:00.000Z",
    content: "still here",
    raw: {},
  }

  await __loopTest.waitForNextEvent(42, {
    clientTools: testClientTools,
    getTools: () => [],
    waitForEvent: async () => {
      calls.push("wait")
      return event
    },
    waitForEventWithTimeout: async () => null,
    injectIncomingEvent: (_convId, incoming) => {
      calls.push(`inject:${incoming.content}`)
      assert.equal(_convId, 42)
      assert.equal(incoming, event)
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  })

  assert.deepEqual(calls, ["wait", "inject:still here"])
})
