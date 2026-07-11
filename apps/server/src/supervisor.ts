import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import type { ResolvedLocalAgent } from "./local-agents"

type SupervisorOptions = {
  agent: ResolvedLocalAgent
  repoRoot: string
  workerEntry: string
  workerEnv: NodeJS.ProcessEnv
  onReady: (agent: ResolvedLocalAgent) => void
}

const HEALTH_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 75_000

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export function matchesWorkerIdentity(value: unknown, agentId: string, instanceId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as { agentId?: unknown; instanceId?: unknown }
  return body.agentId === agentId && body.instanceId === instanceId
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

export class LocalAgentSupervisor {
  readonly agent: ResolvedLocalAgent
  private readonly options: SupervisorOptions
  private child: ChildProcess | null = null
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartDelayMs = 1_000

  constructor(options: SupervisorOptions) {
    this.options = options
    this.agent = options.agent
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.spawnAndWaitForHealth()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (!child || childExited(child)) return
    child.kill("SIGTERM")
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      console.error(`[server] local agent ${this.agent.id} did not stop after ${STOP_TIMEOUT_MS}ms; killing it`)
      child.kill("SIGKILL")
      await waitForExit(child, 5_000)
    }
  }

  private async spawnAndWaitForHealth(): Promise<void> {
    await fs.mkdir(this.agent.home, { recursive: true, mode: 0o700 })
    await fs.chmod(this.agent.home, 0o700)
    const instanceId = randomUUID()
    const child = spawn(process.execPath, ["--import", "tsx", this.options.workerEntry], {
      cwd: this.options.repoRoot,
      env: { ...this.options.workerEnv, NIRI_WORKER_INSTANCE_ID: instanceId },
      stdio: "inherit",
    })
    this.child = child
    child.once("error", (error) => {
      console.error(`[server] local agent ${this.agent.id} failed to spawn:`, error)
    })
    child.once("exit", (code, signal) => this.handleExit(child, code, signal))

    try {
      await this.waitForHealth(child, instanceId)
    } catch (error) {
      if (this.child === child) this.child = null
      if (!childExited(child)) {
        child.kill("SIGTERM")
        await waitForExit(child, 5_000)
      }
      throw error
    }
    if (this.child !== child || childExited(child)) throw new Error(`local agent ${this.agent.id} exited before becoming healthy`)
    this.restartDelayMs = 1_000
    this.options.onReady(this.agent)
  }

  private async waitForHealth(child: ChildProcess, instanceId: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    let lastError = "worker did not answer"
    while (Date.now() < deadline && !childExited(child)) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.agent.port}/health`, { signal: AbortSignal.timeout(1_000) })
        if (res.ok) {
          const body = await res.json()
          if (matchesWorkerIdentity(body, this.agent.id, instanceId)) return
          const identity = body && typeof body === "object" ? body as { agentId?: unknown; instanceId?: unknown } : {}
          lastError = `identity mismatch from agent=${String(identity.agentId)} instance=${String(identity.instanceId)}`
        } else {
          lastError = `${res.status} ${res.statusText}`
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`local agent ${this.agent.id} failed health check: ${lastError}`)
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    console.warn(`[server] local agent ${this.agent.id} exited (${signal ?? code ?? "unknown"})`)
    if (this.stopping) return
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    const delay = this.restartDelayMs
    this.restartDelayMs = Math.min(30_000, delay * 2)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.spawnAndWaitForHealth().catch((error) => {
        console.error(`[server] local agent ${this.agent.id} restart failed:`, error)
        if (!this.stopping) this.scheduleRestart()
      })
    }, delay)
    this.restartTimer.unref?.()
  }
}
