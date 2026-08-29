import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

function runWithHome(home: string, script: string): Promise<number | null> {
  const urls = { db: new URL("./db.ts", import.meta.url).href, jobs: new URL("./process-jobs.ts", import.meta.url).href }
  const wrapped = `
    const { initDb } = await import(${JSON.stringify(urls.db)}); initDb()
    const jobs = await import(${JSON.stringify(urls.jobs)})
    ${script}
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", wrapped], { env: { ...process.env, NIRI_HOME: home }, stdio: "inherit" })
    child.on("error", reject); child.on("close", resolve)
  })
}

test("process jobs persist intent, use typed shell data, and emit one terminal event", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-process-job-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const assert = (await import("node:assert/strict")).default
    const events = []; let calls = 0
    const client = { getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "workspace", root: "/tmp", shellSessionResults: true }), execute: async () => {
      calls++; return { type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(), shell: { sessionId: "sh_1", status: "exited", output: "done", exitCode: 0, signal: null, terminationRequested: false } }
    } }
    jobs.initProcessJobs(client, (event) => { events.push(event); return true })
    assert.throws(() => jobs.getProcessJob("job_ffffffffffffffff"), /not found/)
    const job = await jobs.startProcessJob("printf done")
    assert.match(job.id, /^job_/); assert.equal(job.status, "completed"); assert.equal(job.sessionId, "sh_1")
    assert.equal(jobs.getProcessJob(job.id).output, "done")
    assert.equal(events.length, 1); assert.equal(events[0].source, "process_job")
    assert.equal((await jobs.cancelProcessJob(job.id)).status, "completed")
    assert.equal(calls, 1)
    await jobs.stopProcessJobs()
  `
  assert.equal(await runWithHome(home, script), 0)
})

test("recovery marks unavailable client jobs lost without replaying commands", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-process-lost-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const assert = (await import("node:assert/strict")).default
    const { getDb } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)})
    jobs.listProcessJobs() // create the migration-safe table before seeding a recovered row
    getDb().prepare("insert into process_jobs (id, command, client_workspace_id, session_id, status, created_at) values (?, ?, ?, ?, ?, ?)").run("job_0000000000000001", "must-not-run", "old", "sh_old", "running", new Date().toISOString())
    let calls = 0; const client = { getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "new", root: "/tmp", shellSessionResults: true }), execute: async () => { calls++; throw new Error("must not execute") } }
    jobs.initProcessJobs(client, () => true)
    assert.equal(jobs.getProcessJob("job_0000000000000001").status, "lost"); assert.equal(calls, 0)
    await jobs.stopProcessJobs()
  `
  assert.equal(await runWithHome(home, script), 0)
})


test("process job output and recovery scans are bounded without a 100-row blind spot", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-process-bounds-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const assert = (await import("node:assert/strict")).default
    const { getDb } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)})
    const large = "x".repeat(600 * 1024)
    const client = { getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "workspace", root: "/tmp", shellSessionResults: true }), execute: async () => ({
      type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(),
      shell: { sessionId: "sh_large", status: "exited", output: large, exitCode: 0, signal: null, terminationRequested: false }
    }) }
    jobs.initProcessJobs(client, () => true)
    const created = await jobs.startProcessJob("large output")
    assert.equal(created.outputBytes, Buffer.byteLength(large)); assert.equal(created.outputTruncated, true)
    assert.ok(Buffer.byteLength(created.output) <= 50 * 1024)
    assert.ok(Buffer.byteLength(jobs.listProcessJobs(1)[0].output) <= 1024)
    await jobs.stopProcessJobs()

    for (let i = 0; i < 101; i++) {
      const id = "job_" + i.toString(16).padStart(16, "0")
      getDb().prepare("insert into process_jobs (id, command, client_workspace_id, session_id, status, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(id, "must-not-run", "old-workspace", "sh_" + i, "running", new Date(Date.now() - i).toISOString())
    }
    let calls = 0
    jobs.initProcessJobs({ getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "new-workspace", root: "/tmp", shellSessionResults: true }), execute: async () => { calls++; throw new Error("must not execute") } }, () => true)
    const remaining = getDb().prepare("select count(*) as count from process_jobs where status in ('starting','running','cancelling')").get().count
    assert.equal(remaining, 0); assert.equal(calls, 0)
    await jobs.stopProcessJobs()
  `
  assert.equal(await runWithHome(home, script), 0)
})


test("process jobs complete from detached polling and cancel idempotently", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-process-lifecycle-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const assert = (await import("node:assert/strict")).default
    const events = []; let starts = 0; let terminates = 0
    const client = { getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "workspace", root: "/tmp", shellSessionResults: true }), execute: async (invocation) => {
      const action = invocation.args.action
      if (action === "start") { starts++; return { type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(), shell: { sessionId: starts === 1 ? "sh_run" : "sh_cancel", status: "running", output: "start-", exitCode: null, signal: null, terminationRequested: false } } }
      if (action === "terminate") { terminates++; return { type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(), shell: { sessionId: invocation.args.session_id, status: "terminated", output: "stopped", exitCode: null, signal: "SIGTERM", terminationRequested: true } } }
      return { type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(), shell: { sessionId: invocation.args.session_id, status: "exited", output: "done", exitCode: 0, signal: null, terminationRequested: false } }
    } }
    jobs.initProcessJobs(client, (event) => { events.push(event); return true })
    const running = await jobs.startProcessJob("run"); assert.equal(running.status, "running")
    await jobs.__processJobsTest.pollOne(running.id)
    const completed = jobs.getProcessJob(running.id); assert.equal(completed.status, "completed"); assert.equal(completed.output, "start-done")
    const cancellable = await jobs.startProcessJob("cancel"); assert.equal(cancellable.status, "running")
    const cancelled = await jobs.cancelProcessJob(cancellable.id); assert.equal(cancelled.status, "cancelled")
    assert.equal((await jobs.cancelProcessJob(cancellable.id)).status, "cancelled")
    assert.equal(terminates, 1); assert.equal(events.length, 2)
    await jobs.stopProcessJobs()
  `
  assert.equal(await runWithHome(home, script), 0)
})


test("cancellation wins start and poll races without exposing command or output in events", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-process-races-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const assert = (await import("node:assert/strict")).default
    const { getDb } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)})
    let releaseStart; let releasePoll; let terminateCalls = 0; const events = []
    const result = (sessionId, status, output, terminationRequested=false) => ({ type: "tool.result", invocationId: "i", agentId: "niri", status: "ok", completedAt: new Date().toISOString(), shell: { sessionId, status, output, exitCode: status === "exited" ? 0 : null, signal: status === "terminated" ? "SIGTERM" : null, terminationRequested } })
    let phase = "start-race"
    const client = { getCapabilities: () => ["shell"], getWorkspace: () => ({ id: "workspace", root: "/tmp", shellSessionResults: true }), execute: async (invocation) => {
      if (invocation.args.action === "start" && phase === "start-race") return await new Promise(resolve => { releaseStart = () => resolve(result("sh_start", "running", "secret-start-output")) })
      if (invocation.args.action === "start") return result("sh_poll", "running", "begin-")
      if (invocation.args.action === "poll") return await new Promise(resolve => { releasePoll = () => resolve(result("sh_poll", "running", "middle-")) })
      terminateCalls++; return result(invocation.args.session_id, "terminated", "secret-terminal-output", true)
    } }
    jobs.initProcessJobs(client, (event) => { events.push(event); return true })

    const startingPromise = jobs.startProcessJob("curl -H 'Authorization: secret-token' https://example.invalid")
    await new Promise(resolve => setImmediate(resolve))
    const startingId = getDb().prepare("select id from process_jobs where status='starting'").get().id
    assert.equal((await jobs.cancelProcessJob(startingId)).status, "cancelling")
    releaseStart()
    assert.equal((await startingPromise).status, "cancelled")
    assert.equal(terminateCalls, 1)
    const storedCommand = getDb().prepare("select command from process_jobs where id=?").get(startingId).command
    assert.doesNotMatch(storedCommand, /secret-token|Authorization|curl/)
    assert.doesNotMatch(events[0].content, /secret-start-output|secret-terminal-output/)

    phase = "poll-race"
    const running = await jobs.startProcessJob("poll race")
    const blockedPoll = jobs.__processJobsTest.pollOne(running.id)
    await new Promise(resolve => setImmediate(resolve))
    const cancelling = jobs.cancelProcessJob(running.id)
    releasePoll()
    await blockedPoll
    assert.equal((await cancelling).status, "cancelled")
    assert.equal(terminateCalls, 2)
    assert.equal(jobs.getProcessJob(running.id).terminationRequested, true)
    await jobs.stopProcessJobs()
  `
  assert.equal(await runWithHome(home, script), 0)
})
