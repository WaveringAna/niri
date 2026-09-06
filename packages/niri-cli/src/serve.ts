import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const SERVER_ENTRY = fileURLToPath(new URL("../../../apps/server/src/index.ts", import.meta.url))

export type DaemonRecord = { pid: number; port: number; host: string; startedAt: string }
export type ServeStatus = { state: "running" | "starting" | "stopped" | "stale"; pid?: number; port?: number; host?: string; url?: string }

export type ServeDeps = {
  controlHome?: string
  fetchImpl?: typeof fetch
  spawnImpl?: (file: string, args: string[], options: { detached: boolean; stdio: Array<"ignore" | number>; cwd: string }) => { pid: number; unref: () => void }
  killImpl?: (pid: number, signal?: NodeJS.Signals) => void
  aliveImpl?: (pid: number) => boolean
  waitImpl?: (ms: number) => Promise<void>
}

export type ServePaths = { controlHome: string; pidFile: string; logFile: string }

export function servePaths(deps: ServeDeps = {}): ServePaths {
  const controlHome = path.resolve(deps.controlHome ?? process.env.NIRI_CONTROL_HOME ?? path.join(REPO_ROOT, "data", "control"))
  return { controlHome, pidFile: path.join(controlHome, "server.pid"), logFile: path.join(controlHome, "server.log") }
}

const HEALTH_TIMEOUT_MS = 20_000
const HEALTH_POLL_MS = 400
const STOP_GRACE_MS = 10_000

/** The server only manages runtimes over a loopback config authority; mirror its host rules. */
function healthHost(host: string): string | undefined {
  if (["0.0.0.0", "127.0.0.1", "localhost"].includes(host)) return "127.0.0.1"
  if (["::", "::1"].includes(host)) return "::1"
  return undefined
}

const bracket = (host: string): string => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
const healthUrl = (record: { host: string; port: number }): string => `http://${bracket(healthHost(record.host) ?? record.host)}:${record.port}/health`

const readRecord = (paths: ServePaths): DaemonRecord | undefined => {
  try { return JSON.parse(fs.readFileSync(paths.pidFile, "utf8")) as DaemonRecord } catch { return undefined }
}

const writeRecord = (paths: ServePaths, record: DaemonRecord): void => {
  fs.writeFileSync(paths.pidFile, JSON.stringify(record), { mode: 0o600 })
  fs.chmodSync(paths.pidFile, 0o600)
}

const removeRecord = (paths: ServePaths): void => { try { fs.unlinkSync(paths.pidFile) } catch { /* already gone */ } }

async function healthy(url: string, deps: ServeDeps): Promise<boolean> {
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(1_000) })
    return res.ok
  } catch { return false }
}

async function waitForHealth(record: DaemonRecord, deps: ServeDeps): Promise<boolean> {
  const wait = deps.waitImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthy(healthUrl(record), deps)) return true
    if (!(deps.aliveImpl ?? defaultAlive)(record.pid)) return false
    await wait(HEALTH_POLL_MS)
  }
  return false
}

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const logTail = (paths: ServePaths, lines: number): string => {
  try { return fs.readFileSync(paths.logFile, "utf8").trim().split("\n").slice(-lines).join("\n") } catch { return "" }
}

export async function serveStart(options: { port: number; host: string; agentsDirectory?: string } & ServeDeps): Promise<{ url: string; pid: number; logFile: string }> {
  const { port, host, agentsDirectory, ...deps } = options
  if (!healthHost(host)) throw new Error(`the server requires a loopback or wildcard --host (it manages runtimes over loopback), got ${host}`)
  const paths = servePaths(deps)
  const alive = deps.aliveImpl ?? defaultAlive
  const prior = readRecord(paths)
  if (prior && alive(prior.pid)) throw new Error(`already running (pid ${prior.pid}) at http://${bracket(prior.host)}:${prior.port} — run \`niri serve stop\` first`)
  if (prior) removeRecord(paths)
  if (await healthy(`http://${bracket(healthHost(host)!)}:${port}/health`, deps)) {
    throw new Error(`a server is already listening on port ${port} (started outside this cli, e.g. \`npm start\`); stop it or choose --port`)
  }

  fs.mkdirSync(paths.controlHome, { recursive: true, mode: 0o700 })
  const log = fs.openSync(paths.logFile, "a")
  let child: { pid: number; unref: () => void }
  try {
    const spawnImpl = deps.spawnImpl ?? ((file: string, args: string[], spawnOptions: { detached: boolean; stdio: Array<"ignore" | number>; cwd: string }): { pid: number; unref: () => void } => {
      const child = spawn(file, args, spawnOptions)
      if (child.pid === undefined) throw new Error("server process failed to spawn")
      return { pid: child.pid, unref: () => child.unref() }
    })
    child = spawnImpl(process.execPath, ["--import", "tsx", SERVER_ENTRY, "--port", String(port), "--host", host, ...(agentsDirectory ? ["--agents", agentsDirectory] : [])], { detached: true, stdio: ["ignore", log, log], cwd: REPO_ROOT })
  } finally {
    fs.closeSync(log)
  }
  child.unref()
  const record: DaemonRecord = { pid: child.pid, port, host, startedAt: new Date().toISOString() }
  writeRecord(paths, record)
  if (!(await waitForHealth(record, deps))) {
    const kill = deps.killImpl ?? ((pid, signal) => process.kill(pid, signal))
    try { kill(record.pid, "SIGKILL") } catch { /* already gone */ }
    removeRecord(paths)
    const tail = logTail(paths, 20)
    throw new Error(`server failed to become healthy; recent ${paths.logFile}:${tail ? `\n${tail}` : " (empty)"}`)
  }
  return { url: `http://${bracket(host)}:${port}`, pid: record.pid, logFile: paths.logFile }
}

export async function serveStop(deps: ServeDeps = {}): Promise<{ stopped: boolean; pid?: number; url?: string }> {
  const paths = servePaths(deps)
  const record = readRecord(paths)
  if (!record) return { stopped: false }
  const alive = deps.aliveImpl ?? defaultAlive
  const kill = deps.killImpl ?? ((pid, signal) => process.kill(pid, signal))
  const wait = deps.waitImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const url = `http://${bracket(record.host)}:${record.port}`
  if (!alive(record.pid)) { removeRecord(paths); return { stopped: false, pid: record.pid, url } }
  kill(record.pid, "SIGTERM")
  const deadline = Date.now() + STOP_GRACE_MS
  while (alive(record.pid) && Date.now() < deadline) await wait(200)
  if (alive(record.pid)) kill(record.pid, "SIGKILL")
  removeRecord(paths)
  return { stopped: true, pid: record.pid, url }
}

export async function serveStatus(deps: ServeDeps = {}): Promise<ServeStatus> {
  const paths = servePaths(deps)
  const record = readRecord(paths)
  if (!record) return { state: "stopped" }
  const url = `http://${bracket(record.host)}:${record.port}`
  if (!(deps.aliveImpl ?? defaultAlive)(record.pid)) return { state: "stale", pid: record.pid, port: record.port, host: record.host, url }
  if (!(await healthy(healthUrl(record), deps))) return { state: "starting", pid: record.pid, port: record.port, host: record.host, url }
  return { state: "running", pid: record.pid, port: record.port, host: record.host, url }
}

export const serveLogs = (lines: number, deps: ServeDeps = {}): string => logTail(servePaths(deps), Math.max(1, Math.trunc(lines) || 20))
