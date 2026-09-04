import assert from "node:assert/strict"
import test from "node:test"
import { __policyTest } from "./policies"
import type { Message } from "../types"

/** Only `conversation` is read by the nudge, but keep the full shape honest. */
function makeState(): { conversation: Message[] } {
  return { conversation: [] }
}

test("discord_send nudge appends a follow-up user nudge for unsent Discord replies", () => {
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

  const nudge = __policyTest.discordSendNudge(state.conversation, turnMessages)

  assert.match(String(nudge), /did not call discord_send/i)
})

test("discord_send nudge fires for [discord batch] envelopes (space, not slash)", () => {
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

  const nudge = __policyTest.discordSendNudge(state.conversation, turnMessages)

  assert.match(String(nudge), /did not call discord_send/i)
})

test("discord_send nudge fires after a harness restart when the discord event is pre-turn context", () => {
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

  const turnMessages: Message[] = [state.conversation[1]!]

  const nudge = __policyTest.discordSendNudge(state.conversation, turnMessages)

  assert.match(String(nudge), /did not call discord_send/i)
})

test("discord_send nudge does not fire when discord_send was already called", () => {
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

  const nudge = __policyTest.discordSendNudge(state.conversation, turnMessages)

  assert.equal(nudge, null)
  assert.equal(state.conversation.length, 0)
})

test("discord_send nudge keeps a wake DM active across a preliminary tool step", () => {
  const state = makeState()
  state.conversation.push(
    {
      role: "user",
      content: "[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop",
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_memory",
          type: "function",
          function: { name: "memory_read", arguments: '{"path":"wake.md"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_memory",
      content: "wake notes",
    },
    {
      role: "assistant",
      content: "hey you ^.^",
    },
  )

  const nudge = __policyTest.discordSendNudge(state.conversation, [state.conversation[3]!])

  assert.match(String(nudge), /did not call discord_send/i)
})

test("discord_send nudge sees discord_send from an earlier tool step in the active user turn", () => {
  const state = makeState()
  state.conversation.push(
    {
      role: "user",
      content: "[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop",
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_send",
          type: "function",
          function: { name: "discord_send", arguments: '{"source_item_id":"1","content":"boop"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_send",
      content: "sent!",
    },
    {
      role: "assistant",
      content: "okay, delivered",
    },
  )

  const nudge = __policyTest.discordSendNudge(state.conversation, [state.conversation[3]!])

  assert.equal(nudge, null)
})
