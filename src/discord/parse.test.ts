import assert from "node:assert/strict"
import test from "node:test"
import { parseMessageRecord, renderDiscordUserMentions } from "./parse"
import { fromDiscord } from "../triggers/discord"

const mentionPayload = {
  message: {
    id: "1513348392011694264",
    channel_id: "1497733589545123981",
    guild_id: "1497733589545123980",
    content: "hey <@123> and <@!456>",
    timestamp: "2026-06-15T12:00:00.000Z",
    author: { id: "789", username: "ana" },
    mentions: [
      { id: "123", username: "dawn" },
      { id: "456", global_name: "nova", username: "novabot" },
    ],
  },
  channel: {
    id: "1497733589545123981",
    type: 0,
    name: "mira",
    guild_id: "1497733589545123980",
  },
  guild_name: "home",
}

test("discord user mentions render names instead of ids", () => {
  assert.equal(renderDiscordUserMentions(mentionPayload, "hey <@123> and <@!456>"), "hey @dawn and @nova")

  const record = parseMessageRecord(mentionPayload)
  assert.equal(record?.content, "hey @dawn and @nova")

  const event = fromDiscord(mentionPayload)
  assert.match(event.content, /hey @dawn and @nova/)
  assert.doesNotMatch(event.content, /<@!?/)
})
