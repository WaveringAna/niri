import assert from "node:assert/strict"
import test from "node:test"
import { buildBootstrap } from "./bootstrap"

test("bootstrap explains immutable context recovery tools", async () => {
  const messages = await buildBootstrap({
    source: "chat",
    triggeredAt: new Date().toISOString(),
    content: "hello",
    raw: null,
  })
  const system = String(messages[0]?.content)

  assert.match(system, /authored long-term memories and your immutable conversation archive are different systems/i)
  assert.match(system, /Use `lcm_describe` when you know a summary id/)
  assert.match(system, /`context_grep` to search the verbatim archived messages/)
  assert.match(system, /`context_expand` only when you need the original messages/)
  assert.match(system, /Describe or search before expanding\./)
  assert.match(system, /not a substitute for journaling/i)
})

test("bootstrap restores a rest summary as its own provenance-bearing message", async () => {
  const forest = "[context summary v1]\n[segments]\n[context-summary-id sum_00000000-0000-4000-8000-000000000000]\nolder living summary"
  const messages = await buildBootstrap(
    {
      source: "chat",
      triggeredAt: new Date().toISOString(),
      content: "wake up",
      raw: null,
    },
    {
      restedAt: new Date().toISOString(),
      note: "sleepy",
      forest,
    },
  )

  assert.equal(messages[1]?.content, forest)
  assert.match(String(messages[2]?.content), /context_segments_restored: 1/)
  assert.doesNotMatch(String(messages[2]?.content), /older living summary/)
})

test("bootstrap restores the complete active summary frontier", async () => {
  const forests = [
    "[context summary v1]\n[segments]\n[context-summary-id sum_10000000-0000-4000-8000-000000000000]\nfirst",
    "[context summary v1]\n[segments]\n[context-summary-id sum_20000000-0000-4000-8000-000000000000]\nsecond",
  ]
  const messages = await buildBootstrap(
    { source: "chat", triggeredAt: new Date().toISOString(), content: "wake", raw: null },
    { restedAt: new Date().toISOString(), forest: forests[1]!, forests },
  )

  assert.equal(messages[1]?.content, forests[0])
  assert.equal(messages[2]?.content, forests[1])
  assert.match(String(messages[3]?.content), /context_segments_restored: 2/)
})
