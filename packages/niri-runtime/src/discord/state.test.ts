import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { initDb } from "../db"
import { ingestDiscordEvent } from "./state"

test("discord dm whitelist tests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "niri-test-state-"))
  const originalHome = process.env.NIRI_HOME
  process.env.NIRI_HOME = tempDir

  const originalWhitelist = process.env.DISCORD_DM_WHITELIST
  const originalBotId = process.env.DISCORD_BOT_USER_ID

  try {
    initDb()

    process.env.DISCORD_BOT_USER_ID = "bot123"

    // 1. Whitelist not set - DM from userA should be ingested
    process.env.DISCORD_DM_WHITELIST = ""
    const dmFromUserA = {
      message: {
        id: "msg_dm_1",
        channel_id: "chan_dm_1",
        content: "hello",
        timestamp: "2026-06-15T12:00:00.000Z",
        author: { id: "userA", username: "alice" },
      },
      channel: {
        id: "chan_dm_1",
        type: 1,
      },
    }
    const res1 = ingestDiscordEvent(dmFromUserA)
    assert.equal(res1.stored, true, "Should store DM when whitelist is not set")
    assert.equal(res1.bucket, "dm")

    // 2. Whitelist is set (userA, userB) - DM from userA should be ingested
    process.env.DISCORD_DM_WHITELIST = "userA,userB"
    const dmFromUserA_2 = {
      message: {
        id: "msg_dm_2",
        channel_id: "chan_dm_1",
        content: "hello again",
        timestamp: "2026-06-15T12:01:00.000Z",
        author: { id: "userA", username: "alice" },
      },
      channel: {
        id: "chan_dm_1",
        type: 1,
      },
    }
    const res2 = ingestDiscordEvent(dmFromUserA_2)
    assert.equal(res2.stored, true, "Should store DM when user is whitelisted")
    assert.equal(res2.bucket, "dm")

    // 3. Whitelist is set (userA, userB) - DM from userC should be ignored
    const dmFromUserC = {
      message: {
        id: "msg_dm_3",
        channel_id: "chan_dm_2",
        content: "hey",
        timestamp: "2026-06-15T12:02:00.000Z",
        author: { id: "userC", username: "charlie" },
      },
      channel: {
        id: "chan_dm_2",
        type: 1,
      },
    }
    const res3 = ingestDiscordEvent(dmFromUserC)
    assert.equal(res3.stored, false, "Should not store DM when user is not whitelisted")
    assert.equal(res3.reason, "ignored DM: sender is not in DISCORD_DM_WHITELIST")

    // 4. Whitelist is set (userA, userB) - DM from bot itself (self) should still be stored (for history)
    const dmFromSelf = {
      message: {
        id: "msg_dm_4",
        channel_id: "chan_dm_1",
        content: "bot reply",
        timestamp: "2026-06-15T12:03:00.000Z",
        author: { id: "bot123", username: "mybot" },
      },
      channel: {
        id: "chan_dm_1",
        type: 1,
      },
    }
    const res4 = ingestDiscordEvent(dmFromSelf)
    assert.equal(res4.stored, true, "Should store self DM even if bot is not in whitelist")
    assert.equal(res4.isFromSelf, true)

    // 5. Channel message (non-DM) from non-whitelisted user should still be stored/ingested normally
    const channelMsgFromUserC = {
      message: {
        id: "msg_chan_1",
        channel_id: "chan_guild_1",
        guild_id: "guild123",
        content: "public text",
        timestamp: "2026-06-15T12:04:00.000Z",
        author: { id: "userC", username: "charlie" },
      },
      channel: {
        id: "chan_guild_1",
        type: 0,
        guild_id: "guild123",
      },
    }
    const res5 = ingestDiscordEvent(channelMsgFromUserC)
    assert.equal(res5.stored, true, "Should store non-DM channel messages even if sender is not whitelisted")

  } finally {
    process.env.NIRI_HOME = originalHome
    if (originalWhitelist !== undefined) {
      process.env.DISCORD_DM_WHITELIST = originalWhitelist
    } else {
      delete process.env.DISCORD_DM_WHITELIST
    }
    if (originalBotId !== undefined) {
      process.env.DISCORD_BOT_USER_ID = originalBotId
    } else {
      delete process.env.DISCORD_BOT_USER_ID
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
