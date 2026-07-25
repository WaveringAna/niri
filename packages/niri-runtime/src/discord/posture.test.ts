import assert from "node:assert/strict"
import test from "node:test"
import { formatPostureQueue, isPostureBypass } from "./posture"
import type { PostureQueueRow } from "./db"

test("posture bypass accepts configured users and channels", () => {
  const original = process.env.DISCORD_POSTURE_BYPASS
  process.env.DISCORD_POSTURE_BYPASS = JSON.stringify({
    users: ["user-a"],
    channels: ["channel-a"],
  })

  try {
    assert.equal(isPostureBypass("user-a", "other-channel"), true)
    assert.equal(isPostureBypass("other-user", "channel-a"), true)
    assert.equal(isPostureBypass("other-user", "other-channel"), false)
  } finally {
    if (original === undefined) delete process.env.DISCORD_POSTURE_BYPASS
    else process.env.DISCORD_POSTURE_BYPASS = original
  }
})

test("posture queue formatting groups DMs without exposing message content or ids", () => {
  const rows: PostureQueueRow[] = [
    {
      is_dm: 1,
      author_id: "user-a",
      author_username: "LisyaMyata",
      channel_id: "dm-a",
      channel_name: null,
      count: 8,
      first_seen_at: "2026-07-25T12:00:00.000Z",
    },
    {
      is_dm: 1,
      author_id: "user-b",
      author_username: "HotSocket",
      channel_id: "dm-b",
      channel_name: null,
      count: 492,
      first_seen_at: "2026-07-25T12:01:00.000Z",
    },
  ]

  const summary = formatPostureQueue(rows)
  assert.equal(summary, "these people DM'd you\n@LisyaMyata: 8 messages\n@HotSocket: 492 messages")
  assert.equal(summary.includes("dm-a"), false)
  assert.equal(summary.includes("user-a"), false)
})

test("posture queue reports an empty queue without inventing messages", () => {
  assert.equal(formatPostureQueue([]), "nobody's waiting, keep going")
})
