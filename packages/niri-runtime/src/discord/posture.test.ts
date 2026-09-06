import assert from "node:assert/strict"
import test from "node:test"
import { formatPostureQueue, isPostureBypass } from "./posture"
import { configuredPostures, postureBio, postureReminder } from "./posture-wording"
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

const withPostures = (value: string | undefined, run: () => void): void => {
  const original = process.env.DISCORD_POSTURES
  if (value === undefined) delete process.env.DISCORD_POSTURES
  else process.env.DISCORD_POSTURES = value
  try { run() } finally {
    if (original === undefined) delete process.env.DISCORD_POSTURES
    else process.env.DISCORD_POSTURES = original
  }
}

test("posture bios fall back to neutral wording that carries no persona", () => {
  withPostures(undefined, () => {
    assert.equal(postureBio("hearth"), "around — say hi.")
    assert.match(postureBio("forge"), /^heads down building/)
    assert.equal(postureBio("invented"), "")
    assert.deepEqual(configuredPostures(), {})
    assert.equal([postureBio("hearth"), postureBio("forge")].some((bio) => /violet/i.test(bio)), false)
  })
})

test("configured wording wins, and unusable wording is ignored rather than fatal", () => {
  withPostures(JSON.stringify({
    hearth: { bio: "violet light, warm and steady.", reminder: "still in forge?" },
    forge: { bio: "  ", description: "aimed at one thing." },
    "Bad Name": { bio: "ignored" },
    broken: "not an object",
  }), () => {
    assert.equal(postureBio("hearth"), "violet light, warm and steady.")
    assert.match(postureBio("forge"), /^heads down building/, "a blank bio is not wording")
    assert.deepEqual(Object.keys(configuredPostures()), ["hearth", "forge"])
    assert.deepEqual(configuredPostures().forge, { description: "aimed at one thing." })
  })
  withPostures("{not json", () => { assert.deepEqual(configuredPostures(), {}) })
})

test("the forge reminder is mechanical until an agent writes its own", () => {
  withPostures(undefined, () => { assert.equal(postureReminder("forge"), "you've been in forge for 2 hours, check your queue?") })
  withPostures(JSON.stringify({ forge: { reminder: "two hours aimed; who is waiting?" } }), () => {
    assert.equal(postureReminder("forge"), "two hours aimed; who is waiting?")
  })
})
