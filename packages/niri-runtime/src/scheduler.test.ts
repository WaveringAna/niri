import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

function runWithHome(home: string, script: string): Promise<number | null> {
  const moduleUrls = {
    scheduler: new URL("./scheduler.ts", import.meta.url).href,
    db: new URL("./db.ts", import.meta.url).href,
  }
  const wrapped = `
    const { initDb } = await import(${JSON.stringify(moduleUrls.db)})
    const scheduler = await import(${JSON.stringify(moduleUrls.scheduler)})
    initDb()
    ${script}
  `
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", wrapped], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })
}

test("schedule set/list/cancel validates inputs and round-trips rows", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-scheduler-crud-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const script = `
    const { createSchedule, listSchedules, cancelSchedule } = scheduler
    const assert = (await import("node:assert/strict")).default

    assert.throws(() => createSchedule({ message: "" }), /message is required/)
    assert.throws(() => createSchedule({ message: "hi" }), /exactly one of at or delay_ms/)
    assert.throws(() => createSchedule({ message: "hi", at: "soon", delayMs: 5000 }), /exactly one of at or delay_ms/)
    assert.throws(() => createSchedule({ message: "hi", delayMs: 5 }), /at least 1000/)
    assert.throws(() => createSchedule({ message: "hi", at: "not a date" }), /invalid at timestamp/)
    assert.throws(() => createSchedule({ message: "hi", delayMs: 60000, repeatEveryMs: 1000 }), /repeat_every_ms/)

    const one = createSchedule({ message: "check on the build", delayMs: 60000 })
    assert.match(one.id, /^sch_/)
    assert.equal(one.status, "pending")
    assert.ok(Date.parse(one.fire_at) > Date.now())

    const two = createSchedule({ message: "daily stretch", at: new Date(Date.now() + 3600_000).toISOString(), repeatEveryMs: 86_400_000 })
    assert.equal(two.repeat_every_ms, 86_400_000)

    const listed = listSchedules()
    assert.deepEqual(listed.map((row) => row.id), [one.id, two.id])

    assert.equal(cancelSchedule(one.id), true)
    assert.equal(cancelSchedule(one.id), false)
    assert.deepEqual(listSchedules().map((row) => row.id), [two.id])
  `

  assert.equal(await runWithHome(home, script), 0)
})

test("due schedules dispatch once, advance repeats, and survive rejected dispatch", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-scheduler-fire-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const script = `
    const { createSchedule, listSchedules, __schedulerTest } = scheduler
    const assert = (await import("node:assert/strict")).default

    const past = new Date(Date.now() - 60_000).toISOString()
    const oneShot = createSchedule({ message: "one shot", at: past })
    const repeating = createSchedule({ message: "repeat", at: past, repeatEveryMs: 600_000 })
    const future = createSchedule({ message: "future", delayMs: 3_600_000 })

    const events = []
    __schedulerTest.fireDueSchedules((event) => { events.push(event); return true })
    assert.equal(events.length, 2)
    assert.equal(events[0].source, "cron")
    assert.match(events[0].content, /one shot|repeat/)
    assert.equal(events[0].raw.type, "schedule")

    const listed = listSchedules()
    const oneShotRow = listed.find((row) => row.id === oneShot.id)
    assert.equal(oneShotRow, undefined, "fired one-shot must leave the pending list")

    const repeatRow = listed.find((row) => row.id === repeating.id)
    assert.ok(repeatRow, "repeating schedule stays pending")
    assert.ok(Date.parse(repeatRow.fire_at) > Date.now(), "repeat advances to a future fire time")

    // A rejected dispatch (e.g. shutdown) leaves the row pending and undelivered.
    const rejected = createSchedule({ message: "rejected", at: past })
    __schedulerTest.fireDueSchedules(() => false)
    assert.ok(listSchedules().some((row) => row.id === rejected.id), "rejected dispatch keeps the schedule pending")
  `

  assert.equal(await runWithHome(home, script), 0)
})
