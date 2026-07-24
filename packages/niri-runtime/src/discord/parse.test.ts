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

test("discord server nicknames are preferred and rendered correctly", () => {
  const nicknamePayload = {
    message: {
      id: "1513348392011694264",
      channel_id: "1497733589545123981",
      guild_id: "1497733589545123980",
      content: "hey <@123> and <@!456>",
      timestamp: "2026-06-15T12:00:00.000Z",
      author: { id: "789", username: "ana", global_name: "Ana Global" },
      member: { nickname: "Ana Server Nick", display_name: "Ana Server Nick" },
      mentions: [
        { id: "123", username: "dawn", global_name: "Dawn Global", nickname: "Dawn Server Nick", display_name: "Dawn Server Nick" },
        { id: "456", username: "novabot", global_name: "Nova Global", nickname: "Nova Server Nick", display_name: "Nova Server Nick" },
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

  const record = parseMessageRecord(nicknamePayload)
  assert.equal(record?.authorUsername, "Ana Server Nick")
  assert.equal(record?.content, "hey @Dawn Server Nick and @Nova Server Nick")

  const event = fromDiscord(nicknamePayload)
  assert.match(event.content, /@Ana Server Nick/)
  assert.match(event.content, /hey @Dawn Server Nick and @Nova Server Nick/)
})

test("generic file attachments are included for dms only", () => {
  const attachment = {
    id: "file-1",
    url: "https://cdn.discordapp.com/attachments/file-1/report.pdf",
    filename: "report.pdf",
    content_type: "application/pdf",
    size: 2048,
  }
  const dmEvent = fromDiscord({
    message: {
      id: "dm-1",
      channel_id: "dm-channel",
      channel_type: 1,
      content: "here is the report",
      author: { id: "789", username: "ana" },
      attachments: [attachment],
    },
    is_dm: true,
  })
  assert.match(dmEvent.content, /files \(discord cdn links/)
  assert.match(dmEvent.content, /report\.pdf/)
  assert.match(dmEvent.content, /2048 bytes/)

  const serverEvent = fromDiscord({
    message: {
      id: "server-1",
      channel_id: "server-channel",
      guild_id: "guild-1",
      channel_type: 0,
      content: "here is the report",
      author: { id: "789", username: "ana" },
      attachments: [attachment],
    },
  })
  assert.doesNotMatch(serverEvent.content, /files \(discord cdn links/)
  assert.doesNotMatch(serverEvent.content, /report\.pdf/)
})
