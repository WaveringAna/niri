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

test("bootstrap fully explains persistent Python and hashline workspace editing", async () => {
  const messages = await buildBootstrap(
    { source: "chat", triggeredAt: new Date().toISOString(), content: "fix it", raw: null },
    null,
    {
      clientCapabilities: ["python", "read_file", "edit_file"],
      workspace: { id: "repo", root: "/workspace", persistentPython: true },
    },
  )
  const system = String(messages[0]?.content)

  assert.match(system, /one long-lived namespace/)
  assert.match(system, /run its tests, scripts, CLIs, builds, and dependency checks with `sh/)
  assert.match(system, /read\(path, start_line=1, end_line=None, hashline=False\)/)
  assert.match(system, /edit\(path, target, content\)/)
  assert.match(system, /Hashes are authoritative when line numbers drift/)
  assert.match(system, /out\.list\(\).*out\.page.*out\.tail.*out\.grep/s)
  assert.match(system, /glob\(pattern.*grep\(pattern/s)
  assert.match(system, /kernel starts in the attached workspace.*Do not repeat imports, cwd setup/s)
  assert.match(system, /niri\.whoami\(\).*niri\.deadline\(\)/s)
  assert.match(system, /await niri\.budget\(\)/)
  assert.match(system, /Every other `niri` server method is a coroutine/)
  assert.match(system, /NiriNotFound/)
  assert.match(system, /deadline first interrupts the active cell while preserving the namespace/)
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
