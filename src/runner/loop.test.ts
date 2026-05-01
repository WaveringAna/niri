import assert from "node:assert/strict"
import test from "node:test"
import { __loopTest } from "./loop.js"
import type { LoopState } from "./types.js"

function makeState(): LoopState {
  return {
    conversation: [],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
  }
}

test("applyDiscordSendNudge appends a follow-up user nudge for unsent Discord replies", () => {
  const state = makeState()
  const turnMessages = [
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

test("applyDiscordSendNudge does not fire when discord_send was already called", () => {
  const state = makeState()
  const turnMessages = [
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
