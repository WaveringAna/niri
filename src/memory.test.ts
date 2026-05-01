import test from "node:test"
import assert from "node:assert/strict"
import type { Message } from "./types.js"
import { __memoryTest } from "./memory.js"

test("latestMemoryRecallQuery falls back past scheduled heartbeat", () => {
  const conversation: Message[] = [
    { role: "user", content: "what did we talk about when lisya was buying monero" },
    { role: "assistant", content: "..." },
    { role: "user", content: "Scheduled heartbeat." },
  ]

  assert.equal(
    __memoryTest.latestMemoryRecallQuery(conversation),
    "what did we talk about when lisya was buying monero",
  )
})

test("memoryQueryForUserMessage extracts recent messages from discord batch", () => {
  const batch = `[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z
new_messages=1 channels=1 pending_inbox=0 scope=configured+dm
auto_seen_timeout=10m auto_demoted=0
channel_flag_repairs=0
channel messages are context, not direct requests. replying is optional; use judgment.

recent messages:
- [channel/staying up till 1 billion oclock/#niri] [2026-05-01 03:11:14.553Z] @meowskullz: awa

pending preview:
- (none)`

  assert.equal(
    __memoryTest.memoryQueryForUserMessage(batch),
    "@meowskullz channel/staying up till 1 billion oclock/#niri awa",
  )
})

test("searchTokens keeps meaningful discord batch terms", () => {
  const batchQuery = "@meowskullz channel/staying up till 1 billion oclock/#niri awa"

  assert.deepEqual(__memoryTest.searchTokens(batchQuery), [
    "meowskullz",
    "channel",
    "staying",
    "till",
    "billion",
    "oclock",
    "niri",
    "awa",
  ])
})
