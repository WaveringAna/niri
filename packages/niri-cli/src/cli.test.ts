import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { PassThrough } from "node:stream"
import { main } from "./cli.js"
import { NiriClient } from "./client.js"
import { loadSeed } from "./seed.js"

type Call = { url: string; init?: RequestInit }
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const writer = () => { let text = ""; return { stream: { write: (value: string) => { text += value; return true } }, read: () => text } }

test("bare niri lists and exits when stdout is not a terminal", async () => {
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["--server", "http://example.test"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return reply({ agents: [{ id: "draft", status: "stopped", revision: 2 }] }) },
  })
  assert.equal(result.code, 0); assert.match(output.read(), /^draft\t\tstopped/); assert.equal(calls.length, 1)
})

test("agent creation is stopped unless --start is explicit and sends bearer auth", async () => {
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["--server", "https://control.test", "--token", "operator", "agents", "create", "draft"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return reply({ id: "draft", config: {} }) },
  })
  assert.equal(result.code, 0); assert.equal(calls[0]?.url, "https://control.test/agents")
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer operator")
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { id: "draft", start: false })
})

test("config writes read the revision before issuing their CAS patch", async () => {
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["--token", "operator", "config", "set", "draft", "runtime.batch", "4"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return calls.length === 1 ? reply({ id: "draft", revision: 7, config: {} }) : reply({ id: "draft", revision: 8, config: {} })
    },
  })
  assert.equal(result.code, 0); assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)).patch, { runtime: { batch: 4 } })
  assert.equal(JSON.parse(String(calls[1]?.init?.body)).expectedRevision, 7)
})

test("seed loader accepts yaml and preserves configPolicy inside config", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "niri-cli-")); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "agents.yaml")
  await fs.writeFile(file, "agents:\n  - id: draft\n    config:\n      configPolicy:\n        enforcedPaths: [model]\n      model:\n        name: test\n")
  assert.deepEqual(await loadSeed(file), [{ id: "draft", config: { configPolicy: { enforcedPaths: ["model"] }, model: { name: "test" } } }])
})


test("--help never contacts an unavailable server", async () => {
  const output = writer(); const errors = writer(); let called = false
  const result = await main(["--help"], { stdout: output.stream, stderr: errors.stream, fetchImpl: async () => { called = true; throw new Error("offline") } })
  assert.equal(result.code, 0); assert.equal(called, false); assert.match(output.read(), /usage:/i)
})

test("config apply seeds a config after reading its revision and writes readable JSON", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "niri-cli-")); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "agent.json"); await fs.writeFile(file, JSON.stringify({ model: { name: "test" } }))
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["--token", "operator", "config", "apply", "draft", file], { isTty: false, stdout: output.stream, stderr: errors.stream, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); return calls.length === 1 ? reply({ id: "draft", revision: 2, config: {} }) : reply({ id: "draft", revision: 3, config: {} })
  } })
  assert.equal(result.code, 0); assert.equal(calls[1]?.url.endsWith("/agents/draft/config/seed"), true)
  assert.match(output.read(), /"revision": 3/)
})

test("plain agent seed uses filename for its id", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "niri-cli-")); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "worker.yaml"); await fs.writeFile(file, "model:\n  name: test\n")
  assert.deepEqual(await loadSeed(file), [{ id: "worker", config: { model: { name: "test" } } }])
})


test("seed creates after a real 404 response whose message has no status prefix", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "niri-cli-")); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "draft.yaml"); await fs.writeFile(file, "model:\n  name: test\n")
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["--token", "operator", "seed", file], { isTty: false, stdout: output.stream, stderr: errors.stream, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); return calls.length === 1 ? reply({ error: "agent draft not found" }, 404) : reply({ id: "draft", config: {} })
  } })
  assert.equal(result.code, 0); assert.equal(calls[1]?.url.endsWith("/agents"), true)
  assert.equal(JSON.parse(String(calls[1]?.init?.body)).seed, true)
})

test("client rejects credential URLs and blocks authenticated redirects", async () => {
  assert.throws(() => new NiriClient({ baseUrl: "http://token@127.0.0.1:3000" }), /credentials/)
  let redirect: RequestRedirect | undefined
  const client = new NiriClient({ baseUrl: "https://control.test", token: "operator", fetchImpl: async (_url, init) => { redirect = init?.redirect; return reply({ agents: [] }) } })
  await client.list(); assert.equal(redirect, "error")
})


test("non-interactive create sends no model and hints that none is set", async () => {
  const output = writer(); const errors = writer(); const calls: Call[] = []
  const result = await main(["agents", "create", "draft"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return reply({ id: "draft", revision: 1, config: {} }) },
  })
  assert.equal(result.code, 0)
  const body = JSON.parse(String(calls[0]?.init?.body))
  assert.equal(body.config, undefined)
  assert.match(output.read(), /no model set yet/)
})

test("chat refuses to start without a terminal", async () => {
  const output = writer(); const errors = writer()
  const result = await main(["chat", "nova"], { isTty: false, stdout: output.stream, stderr: errors.stream, fetchImpl: async () => reply({ ok: true }) })
  assert.equal(result.code, 1)
  assert.match(errors.read(), /niri chat needs a terminal/)
})

test("bare niri on a terminal mounts the agents view and q ends the command", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input }) as unknown as NodeJS.ReadStream
  const screen = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  let painted = ""; (screen as unknown as PassThrough).on("data", (chunk: Buffer) => { painted += String(chunk) })
  const errors = writer()
  const running = main(["--server", "http://example.test"], {
    isTty: true, input, output: screen, stderr: errors.stream,
    fetchImpl: async () => reply({ agents: [{ id: "alpha", status: "running" }] }),
  })
  for (let attempt = 0; attempt < 400 && !painted.includes("alpha"); attempt++) await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.match(painted, /alpha/)
  ;(input as unknown as PassThrough).write("q")
  assert.deepEqual(await running, { code: 0 })
})

test("serve start daemonizes, records a pidfile, and waits for health", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-serve-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  const output = writer(); const errors = writer()
  const spawned: Array<{ file: string; args: string[]; detached: boolean; stdio: unknown[] }> = []
  const healthUrls: string[] = []
  const result = await main(["serve", "--port", "4321", "--host", "0.0.0.0", "--agents", "/tmp/none"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    serveDeps: {
      controlHome: home,
      fetchImpl: async (url) => { healthUrls.push(String(url)); return reply({ ok: true }, spawned.length > 0 ? 200 : 503) },
      spawnImpl: (file, args, options) => { spawned.push({ file, args, detached: options.detached, stdio: options.stdio }); return { pid: 4242, unref: () => undefined } },
      aliveImpl: () => true,
    },
  })
  assert.equal(result.code, 0, errors.read())
  assert.match(output.read(), /serving at http:\/\/0\.0\.0\.0:4321 \(pid 4242\)/)
  const record = JSON.parse(await fs.readFile(path.join(home, "server.pid"), "utf8")) as { pid: number; port: number; host: string }
  assert.equal(record.pid, 4242); assert.equal(record.port, 4321); assert.equal(record.host, "0.0.0.0")
  const args = spawned[0]!.args
  assert.ok(args.includes("--port") && args.includes("4321"))
  assert.ok(args.includes("--host") && args.includes("0.0.0.0"))
  assert.ok(args.includes("--agents") && args.includes("/tmp/none"))
  assert.ok(spawned[0]!.file.endsWith("node") || spawned[0]!.file.includes("node"))
  assert.ok(args.some((value) => value.endsWith("apps/server/src/index.ts")))
  assert.equal(spawned[0]!.detached, true)
  assert.equal(spawned[0]!.stdio[0], "ignore")
  assert.ok(typeof spawned[0]!.stdio[1] === "number" && typeof spawned[0]!.stdio[2] === "number")
  assert.ok(healthUrls.every((url) => url === "http://127.0.0.1:4321/health"), JSON.stringify(healthUrls))
})

test("serve start refuses when the recorded daemon is already running", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-serve-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, "server.pid"), JSON.stringify({ pid: 777, port: 4321, host: "127.0.0.1", startedAt: "2026-01-01T00:00:00Z" }))
  const output = writer(); const errors = writer()
  const result = await main(["serve", "--port", "4321"], { isTty: false, stdout: output.stream, stderr: errors.stream, serveDeps: { controlHome: home, aliveImpl: () => true } })
  assert.equal(result.code, 1)
  assert.match(errors.read(), /already running \(pid 777\)/)
})

test("serve stop terminates the recorded pid and clears the pidfile", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-serve-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, "server.pid"), JSON.stringify({ pid: 777, port: 4321, host: "127.0.0.1", startedAt: "2026-01-01T00:00:00Z" }))
  const output = writer(); const errors = writer()
  let alive = true; const killed: string[] = []
  const result = await main(["serve", "stop"], {
    isTty: false, stdout: output.stream, stderr: errors.stream,
    serveDeps: { controlHome: home, aliveImpl: () => alive, killImpl: (pid, signal) => { killed.push(`${pid}:${signal ?? ""}`); alive = false }, waitImpl: async () => undefined },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(killed, ["777:SIGTERM"])
  assert.equal(await fs.readFile(path.join(home, "server.pid"), "utf8").catch(() => "gone"), "gone")
  assert.match(output.read(), /"status": "stopped"/)
})

test("serve status reports a healthy daemon and serve logs tails the file", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-serve-")); t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, "server.pid"), JSON.stringify({ pid: 777, port: 4321, host: "127.0.0.1", startedAt: "2026-01-01T00:00:00Z" }))
  await fs.writeFile(path.join(home, "server.log"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"))
  const deps = { controlHome: home, aliveImpl: () => true, fetchImpl: async () => reply({ ok: true }) }
  const status = writer(); const errors = writer()
  await main(["serve", "status", "--json"], { isTty: false, stdout: status.stream, stderr: errors.stream, serveDeps: deps })
  const reported = JSON.parse(status.read()) as { state: string; pid?: number; url?: string }
  assert.equal(reported.state, "running"); assert.equal(reported.pid, 777); assert.equal(reported.url, "http://127.0.0.1:4321")
  const logs = writer()
  await main(["serve", "logs", "--lines", "2"], { isTty: false, stdout: logs.stream, stderr: errors.stream, serveDeps: deps })
  assert.equal(logs.read().trim(), "line 29\nline 30")
})
