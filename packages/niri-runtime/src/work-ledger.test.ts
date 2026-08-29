import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

function runWithHome(home: string, script: string): Promise<number | null> {
  const urls = { db: new URL("./db.ts", import.meta.url).href, work: new URL("./work-ledger.ts", import.meta.url).href }
  const wrapped = `const { initDb } = await import(${JSON.stringify(urls.db)}); const work = await import(${JSON.stringify(urls.work)}); initDb(); ${script}`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", wrapped], { env: { ...process.env, NIRI_HOME: home }, stdio: "inherit" })
    child.on("error", reject)
    child.on("close", resolve)
  })
}

test("work ledger creates, lists, updates, closes, and persists", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-work-ledger-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  assert.equal(await runWithHome(home, `
    const assert = (await import("node:assert/strict")).default
    const one = work.createWorkItem({ title: "  write   tests ", note: " first note " })
    const two = work.createWorkItem({ title: "paused" })
    assert.match(one.id, /^work_/); assert.equal(one.title, "write tests"); assert.equal(one.note, "first note")
    assert.ok(Date.parse(one.createdAt)); assert.equal(one.status, "active")
    work.updateWorkItem({ id: two.id, status: "paused" })
    assert.deepEqual(work.listWorkItems().map(x => x.id), [one.id, two.id])
    const closed = work.closeWorkItem({ id: one.id, status: "completed" })
    assert.equal(closed.closedAt, closed.updatedAt); assert.deepEqual(work.listWorkItems().map(x => x.id), [two.id])
    assert.equal(work.listWorkItems({ status: "completed" })[0].id, one.id)
    assert.throws(() => work.updateWorkItem({ id: one.id, title: "no" }), /already closed/)
    assert.throws(() => work.createWorkItem({ title: " " }), /required/)
    assert.throws(() => work.createWorkItem({ title: 5 }), /string/)
    assert.throws(() => work.updateWorkItem({ id: two.id }), /at least one/)
    assert.throws(() => work.closeWorkItem({ id: two.id, status: "paused" }), /completed or cancelled/)
  `), 0)
  assert.equal(await runWithHome(home, `
    const assert = (await import("node:assert/strict")).default
    assert.equal(work.listWorkItems({ status: "completed" }).length, 1)
  `), 0)
})

test("work wake formatting is bounded and excludes closed work", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-work-wake-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  assert.equal(await runWithHome(home, `
    const assert = (await import("node:assert/strict")).default
    assert.equal(work.formatCurrentWorkForWake(), null)
    for (let i = 0; i < 10; i++) work.createWorkItem({ title: "item " + i, note: "line " + "x".repeat(500) })
    const closed = work.createWorkItem({ title: "closed" }); work.closeWorkItem({ id: closed.id, status: "cancelled" })
    const text = work.formatCurrentWorkForWake()
    assert.equal(text.startsWith("[current work ledger — durable state]"), true)
    assert.ok(Array.from(text).length <= 2000); assert.match(text, /more current items/); assert.doesNotMatch(text, /closed/)
    assert.equal(text.split("- [active]").length - 1, 8)
  `), 0)
})
