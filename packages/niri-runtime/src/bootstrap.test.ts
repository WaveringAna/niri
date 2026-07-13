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
  assert.match(system, /`context_grep` to search the verbatim archived messages/)
  assert.match(system, /`context_expand` only when you need to read the original messages/)
  assert.match(system, /Search before expanding\./)
  assert.match(system, /not a substitute for journaling/i)
})
