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

test("memoryQueryForUserMessage extracts structured parts from discord batch", () => {
  const batch = `[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z
new_messages=1 channels=1 pending_inbox=0 scope=configured+dm
auto_seen_timeout=10m auto_demoted=0
channel_flag_repairs=0
channel messages are context, not direct requests. replying is optional; use judgment.

recent messages:
- [channel/staying up till 1 billion oclock/#niri] [2026-05-01 03:11:14.553Z] @meowskullz: awa

pending preview:
- (none)`

  assert.deepEqual(__memoryTest.memoryQueryForUserMessage(batch), {
    sender: "meowskullz",
    source: "channel/staying up till 1 billion oclock/#niri",
    body: "awa",
  })
})

test("memoryQueryForUserMessage parses discord DM envelope into parts", () => {
  const dm = `[discord/dm] @meowskullz
context: DM 1234567890
message_id: 9999
timestamp: 2026-05-01T00:00:00Z
action: This is a direct message. Reply if it needs a response.

thanks`

  const parts = __memoryTest.memoryQueryForUserMessage(dm)
  assert.equal(parts.sender, "meowskullz")
  assert.equal(parts.source, "DM")
  assert.equal(parts.body, "thanks")
})

test("buildSearchProfile uses sender as primary signal and drops source", async () => {
  const profile = await __memoryTest.buildSearchProfile({
    sender: "meowskullz",
    source: "DM",
    body: "thanks",
  })

  assert.equal(profile.sender, "meowskullz")
  assert.equal(profile.personQuery, true)
  assert.deepEqual(profile.bodyTokens, ["thanks"])
  assert.ok(profile.tokens.includes("meowskullz"))
  assert.ok(profile.tokens.includes("thanks"))
  assert.ok(!profile.tokens.includes("dm"), "source label should not become a search token")
})

test("resolveAliases follows transitive mappings without cycles", () => {
  const map = {
    meowskullz: ["ana"],
    ana: ["ana_canonical"],
    foo: ["meowskullz"],
  }
  assert.deepEqual(__memoryTest.resolveAliases("meowskullz", map), ["ana", "ana_canonical"])
  assert.deepEqual(__memoryTest.resolveAliases("foo", map), ["meowskullz", "ana", "ana_canonical"])
  assert.deepEqual(__memoryTest.resolveAliases(null, map), [])
})

test("buildSearchProfile expands sender via alias map", async (t) => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const url = await import("node:url")
  const memoriesDir = path.resolve(url.fileURLToPath(import.meta.url), "../../home/memories")
  const aliasFile = path.join(memoriesDir, "aliases.json")
  const had = await fs.readFile(aliasFile, "utf-8").catch(() => null)

  await fs.mkdir(memoriesDir, { recursive: true })
  await fs.writeFile(aliasFile, JSON.stringify({ meowskullz: ["ana"] }), "utf-8")

  t.after(async () => {
    if (had !== null) await fs.writeFile(aliasFile, had, "utf-8")
    else await fs.rm(aliasFile, { force: true })
  })

  const profile = await __memoryTest.buildSearchProfile({
    sender: "meowskullz",
    source: "DM",
    body: "thanks",
  })

  assert.deepEqual(profile.senderAliases, ["ana"])
  assert.ok(profile.tokens.includes("ana"))
})

test("buildSearchProfile body informativeness short-circuits on body-people", async () => {
  const withPerson = await __memoryTest.buildSearchProfile({
    sender: "meowskullz",
    source: "DM",
    body: "yayy, who is rea",
  })
  assert.equal(withPerson.bodyInformative, true)

  const empty = await __memoryTest.buildSearchProfile({ sender: "meowskullz", source: "DM", body: "" })
  assert.equal(empty.bodyInformative, false)
})

test("buildSearchProfile detects people mentioned in body", async () => {
  const profile = await __memoryTest.buildSearchProfile({
    sender: "meowskullz",
    source: "DM",
    body: "patpat, who is rea",
  })

  assert.ok(profile.bodyPeople.includes("rea"), `expected rea in bodyPeople, got ${JSON.stringify(profile.bodyPeople)}`)
  assert.ok(profile.tokens.includes("rea"))
  assert.equal(profile.personQuery, true)
})

test("searchTokens keeps meaningful body terms", () => {
  assert.deepEqual(__memoryTest.searchTokens("staying up till 1 billion oclock awa"), [
    "staying",
    "till",
    "billion",
    "oclock",
    "awa",
  ])
})
