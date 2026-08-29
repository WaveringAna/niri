import { randomBytes } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import {
  CLIENT_WORKSPACE_ROOT,
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_RESULT_BYTES,
  SHELL_ENV,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
} from "./config.js"
import type { RunRawOptions } from "./types.js"

export type ShellSessionAction = "start" | "poll" | "terminate"
export type ShellSessionStatus = "running" | "exited" | "terminated" | "failed"

export class UnknownShellSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown shell session: ${sessionId}`)
    this.name = "UnknownShellSessionError"
  }
}

export type ShellSessionResult = {
  sessionId: string
  status: ShellSessionStatus
  output: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  terminationRequested: boolean
}

type ManagedShellSession = {
  id: string
  child: ChildProcess
  output: string
  outputBytes: number
  deliveredOffset: number
  status: ShellSessionStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  error: Error | null
  terminationRequested: boolean
  createdAt: number
  completedAt: number | null
  waiters: Set<() => void>
  forceKillTimer: ReturnType<typeof setTimeout> | null
}

const shellSessions = new Map<string, ManagedShellSession>()
const MAX_SHELL_SESSIONS = 64

function applyTerminalControls(str: string): string {
  let out = ""

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]

    if (ch === "\r") {
      if (str[i + 1] === "\n") {
        out += "\n"
        i += 1
      } else {
        const lineStart = out.lastIndexOf("\n") + 1
        out = out.slice(0, lineStart)
      }
      continue
    }

    if (ch === "\b" || ch === "\x7f") {
      if (out.length > 0 && out[out.length - 1] !== "\n") out = out.slice(0, -1)
      continue
    }

    if (ch === "\x00") continue
    out += ch
  }

  return out
}

/** Strip ANSI/VT escape sequences and apply simple terminal line controls. */
export function cleanOutput(str: string): string {
  const withoutEscapes = str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/(?:\x03|\^C)\s*/g, "")

  return applyTerminalControls(withoutEscapes)
}

function captureLimitBytes(): number {
  return Math.max(1_000_000, MAX_RESULT_BYTES * 2)
}

function commandEnvironment(): Record<string, string> {
  return {
    ...SHELL_ENV,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    LESS: "FRX",
  }
}

function spawnCommand(command: string, cwd: string): ChildProcess {
  const args = USE_DOCKER_SHELL
    ? ["exec", "-i", "-u", CONTAINER_USER, "-w", cwd, CONTAINER_NAME, "bash", "--noprofile", "--norc", "-c", command]
    : ["--noprofile", "--norc", "-c", command]
  const program = USE_DOCKER_SHELL ? "docker" : "bash"

  return spawn(program, args, {
    cwd: USE_DOCKER_SHELL ? undefined : cwd,
    env: commandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    // This mirrors OpenCode's per-call isolation and lets explicit termination
    // address the command's descendants, not only the top-level shell.
    detached: process.platform !== "win32",
  })
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when the process group no longer exists.
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill(signal)
  } catch {
    // The process already exited.
  }
}

function scheduleForceKill(session: ManagedShellSession): void {
  if (session.forceKillTimer) return
  session.forceKillTimer = setTimeout(() => terminateProcessGroup(session.child, "SIGKILL"), 3_000)
  session.forceKillTimer.unref?.()
}

function notifyWaiters(session: ManagedShellSession): void {
  for (const resolve of session.waiters) resolve()
  session.waiters.clear()
}

function failSession(session: ManagedShellSession, error: Error): void {
  if (session.status !== "running") return
  session.status = "failed"
  session.error = error
  session.completedAt = Date.now()
  terminateProcessGroup(session.child, "SIGKILL")
  notifyWaiters(session)
}

function pruneShellSessions(): void {
  if (shellSessions.size < MAX_SHELL_SESSIONS) return
  const completed = [...shellSessions.values()]
    .filter((session) => session.status !== "running")
    .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt))
  for (const session of completed) {
    shellSessions.delete(session.id)
    if (shellSessions.size < MAX_SHELL_SESSIONS) return
  }
  throw new Error(`too many live shell sessions (${MAX_SHELL_SESSIONS}); poll or terminate an existing session`)
}

function createShellSession(command: string, cwd = CLIENT_WORKSPACE_ROOT): ManagedShellSession {
  pruneShellSessions()
  const id = `sh_${randomBytes(8).toString("hex")}`
  const child = spawnCommand(command, cwd)
  const session: ManagedShellSession = {
    id,
    child,
    output: "",
    outputBytes: 0,
    deliveredOffset: 0,
    status: "running",
    exitCode: null,
    signal: null,
    error: null,
    terminationRequested: false,
    createdAt: Date.now(),
    completedAt: null,
    waiters: new Set(),
    forceKillTimer: null,
  }
  shellSessions.set(id, session)

  const append = (chunk: Buffer): void => {
    if (session.status === "failed") return
    const text = chunk.toString("utf8")
    session.output += text
    session.outputBytes += Buffer.byteLength(text, "utf8")
    if (session.outputBytes > captureLimitBytes()) {
      failSession(session, new Error(`command output exceeded ${captureLimitBytes()} bytes`))
    }
  }

  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
  child.on("error", (error) => failSession(session, error))
  child.on("close", (exitCode, signal) => {
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer)
    session.forceKillTimer = null
    session.exitCode = exitCode
    session.signal = signal as NodeJS.Signals | null
    if (session.status === "running") {
      session.status = session.terminationRequested ? "terminated" : "exited"
      session.completedAt = Date.now()
    }
    notifyWaiters(session)
  })

  return session
}

async function waitForSession(session: ManagedShellSession, timeoutMs: number): Promise<void> {
  if (session.status !== "running") return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.waiters.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    session.waiters.add(finish)
  })
}

function takeSessionResult(session: ManagedShellSession): ShellSessionResult {
  const output = cleanOutput(session.output.slice(session.deliveredOffset)).trimEnd()
  session.deliveredOffset = session.output.length
  return {
    sessionId: session.id,
    status: session.status,
    output,
    exitCode: session.exitCode,
    signal: session.signal,
    terminationRequested: session.terminationRequested,
  }
}

export async function runShellSession(input: {
  action?: ShellSessionAction
  command?: string
  sessionId?: string
  timeoutMs?: number
  cwd?: string
}): Promise<ShellSessionResult> {
  const action = input.action ?? "start"
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)

  if (action === "start") {
    const command = String(input.command ?? "")
    if (!command.trim()) throw new Error("command is required when shell action is start")
    const session = createShellSession(command, input.cwd ?? CLIENT_WORKSPACE_ROOT)
    await waitForSession(session, timeoutMs)
    if (session.error) throw session.error
    const result = takeSessionResult(session)
    if (result.status !== "running") shellSessions.delete(session.id)
    return result
  }

  const sessionId = String(input.sessionId ?? "").trim()
  if (!sessionId) throw new Error(`session_id is required when shell action is ${action}`)
  const session = shellSessions.get(sessionId)
  if (!session) throw new UnknownShellSessionError(sessionId)

  if (action === "terminate" && session.status === "running") {
    session.terminationRequested = true
    terminateProcessGroup(session.child, "SIGTERM")
    scheduleForceKill(session)
  }

  await waitForSession(session, timeoutMs)
  if (session.error) throw session.error
  const result = takeSessionResult(session)
  if (result.status !== "running") shellSessions.delete(session.id)
  return result
}

export async function closeShellSessions(): Promise<void> {
  const running = [...shellSessions.values()].filter((session) => session.status === "running")
  for (const session of running) {
    session.terminationRequested = true
    terminateProcessGroup(session.child, "SIGTERM")
    scheduleForceKill(session)
  }
  await Promise.all(running.map((session) => waitForSession(session, 3_500)))
  for (const session of running) {
    if (session.status === "running") terminateProcessGroup(session.child, "SIGKILL")
  }
  shellSessions.clear()
}

async function runProcess(command: string, cwd: string, options: RunRawOptions = {}): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  const child = spawnCommand(command, cwd)

  return new Promise((resolve, reject) => {
    let raw = ""
    let rawBytes = 0
    let settled = false
    let failure: Error | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }

    const failAndTerminate = (error: Error, signal: NodeJS.Signals): void => {
      if (failure) return
      failure = error
      terminateProcessGroup(child, signal)
      if (signal !== "SIGKILL") {
        forceKillTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 3_000)
        forceKillTimer.unref?.()
      }
    }

    const append = (chunk: Buffer): void => {
      if (settled || failure) return
      const text = chunk.toString("utf8")
      raw += text
      rawBytes += Buffer.byteLength(text, "utf8")
      if (rawBytes > captureLimitBytes()) {
        failAndTerminate(new Error(`command output exceeded ${captureLimitBytes()} bytes`), "SIGKILL")
      }
    }

    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.on("close", () => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else resolve(cleanOutput(raw).trimEnd())
    })

    const timeoutTimer = setTimeout(() => {
      failAndTerminate(new Error(`Command timed out after ${timeoutMs}ms: ${command}`), "SIGTERM")
    }, timeoutMs)
    timeoutTimer.unref?.()
  })
}

export async function currentWorkingDirectory(_timeoutMs?: number): Promise<string> {
  return CLIENT_WORKSPACE_ROOT
}

/** Run a short internal helper. Unlike model shell sessions, helper timeouts are fatal. */
export async function runRaw(command: string, options: RunRawOptions = {}): Promise<string> {
  return runProcess(command, CLIENT_WORKSPACE_ROOT, options)
}
