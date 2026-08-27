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

test("formatDiscordSendResult emits only a minimal success ack", () => {
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

  assert.equal(ack, "sent!")

  const ackWithContent = __toolRegistryTest.formatDiscordSendResult({
    ok: true,
    sent_message_id: "1510087371281010840",
    channel_id: "1497733589545123981",
  })

  assert.equal(ackWithContent, "sent!")
})

test("client image validation checks decoded size and file signature", () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const image = {
    mime: "image/png",
    bytes: data.length,
    dataUrl: `data:image/png;base64,${data.toString("base64")}`,
  }

  assert.doesNotThrow(() => __toolRegistryTest.validateClientImage(image, data.length))
  assert.throws(
    () => __toolRegistryTest.validateClientImage({ ...image, bytes: data.length + 1 }, data.length + 1),
    /byte count mismatch/,
  )
  assert.throws(
    () => __toolRegistryTest.validateClientImage({ ...image, mime: "image/jpeg", dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` }, data.length),
    /do not match/,
  )
  assert.throws(() => __toolRegistryTest.validateClientImage(image, data.length - 1), /safety limit/)
})


test("session boundary resets Python only when the client advertises it",async()=>{
 const calls:Array<{tool:string;args:Record<string,unknown>}>=[];const client={getCapabilities:()=>["python"],execute:async(input:{tool:string;args:Record<string,unknown>})=>{calls.push({tool:input.tool,args:input.args});return {status:"ok",output:"reset"}}} as never
 await __toolRegistryTest.resetClientPythonAtSessionBoundary({clientTools:client})
 assert.deepEqual(calls,[{tool:"python",args:{action:"reset"}}])
 const without={getCapabilities:()=>["shell"],execute:async()=>{throw new Error("must not run")}} as never
 await __toolRegistryTest.resetClientPythonAtSessionBoundary({clientTools:without})
})
