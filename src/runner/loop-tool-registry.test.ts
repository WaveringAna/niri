import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "../types"
import { __toolRegistryTest } from "./loop-tool-registry"

function assistantTool(name: string, id: string, args = "{}"): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name,
          arguments: args,
        },
      },
    ],
  }
}

function toolResult(id: string, content: string): Message {
  return {
    role: "tool",
    tool_call_id: id,
    content,
  }
}

test("discord_send without channel only accepts source_item_id from latest Discord target context", () => {
  const conversation: Message[] = [
    {
      role: "user",
      content: "[incoming — discord]\n\n[discord batch]\nrecent messages:\n- source_item_id=chan0 [channel/server/#room] [May 29, 2026, 9:08 PM EDT] @nova: hi",
    },
    assistantTool("discord_backread", "call_dm"),
    toolResult("call_dm", '[{"source_item_id":"dm1","message_id":"dm1","channel_id":"dm-channel"}]'),
    assistantTool("discord_backread", "call_channel"),
    toolResult("call_channel", '[{"source_item_id":"chan1","message_id":"chan1","channel_id":"server-channel"}]'),
  ]

  const dmError = __toolRegistryTest.validateNoChannelDiscordSendTarget({ conversation }, undefined, "dm1")
  assert.ok(dmError)
  assert.match(dmError, /latest Discord target context/)
  assert.equal(
    __toolRegistryTest.validateNoChannelDiscordSendTarget({ conversation }, undefined, "chan1"),
    null,
  )
})

test("discord_send without channel accepts current Discord event source_item_id", () => {
  const conversation: Message[] = [
    {
      role: "user",
      content: "[discord/channel] @nova\ncontext: server/#room\nmessage_id: 123\nsource_item_id: 123\n\naurora",
    },
  ]

  assert.equal(
    __toolRegistryTest.validateNoChannelDiscordSendTarget({ conversation }, undefined, "123"),
    null,
  )
})

test("formatDiscordSendResult emits a compact one-line ack", () => {
  const ack = __toolRegistryTest.formatDiscordSendResult({
    ok: true,
    sent_message_id: "1510087371281010840",
    channel_id: "1497733589545123981",
    reply_mode: "auto",
    used_reference_message_id: null,
    resolved_source_item_id: null,
    inferred_source_item_id: null,
    stored: true,
  })

  assert.equal(ack, "discord_send ok sent_message_id=1510087371281010840 channel_id=1497733589545123981")
  assert.equal(ack.includes("\n"), false)
  assert.equal(ack.includes("null"), false)
})
