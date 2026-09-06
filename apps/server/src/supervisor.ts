import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import type { ResolvedLocalAgent } from "./local-agents"

type SupervisorOptions = {
  agent: ResolvedLocalAgent
  repoRoot: string
  workerEntry: string
  workerEnv: NodeJS.ProcessEnv
  onReady: (agent: ResolvedLocalAgent, instanceId: string) => void
  configToken?: string
  /** Config reconciliation owns failed revisions; it may disable process retries. */
  autoRestart?: boolean
  /** false prevents retries before a config revision first becomes healthy. */
  retryFailedStart?: boolean
  onStartFailure?: (error: unknown) => void
  onExit?: () => void
}

const HEALTH_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 75_000

export class ApplicationNotReadyError extends Error {
  constructor(message: string) { super(message); this.name = "ApplicationNotReadyError" }
}

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
  private healthyOnce = false

  constructor(options: SupervisorOptions) {
    this.options = options
    this.agent = options.agent
  }

  get running(): boolean { return this.child !== null && !childExited(this.child) }

  async start(): Promise<void> {
    this.stopping = false
    await this.spawnAndWaitForHealth()
  }

  /**
   * Starts the agent without blocking or failing the caller: a failed boot
   * (unhealthy worker, crash before ready) logs without taking down the control
   * plane. Config-managed supervisors can delegate retry policy to their owner.
   */
  startInBackground(): void {
    this.stopping = false
    void this.spawnAndWaitForHealth().catch((error) => {
      console.error(
        `[server] local agent ${this.agent.id} failed to start (${error instanceof Error ? error.message : String(error)})`,
      )
      this.options.onStartFailure?.(error)
      if (!this.stopping && this.options.autoRestart !== false && (this.healthyOnce || this.options.retryFailedStart !== false)) this.scheduleRestart()
    })
  }

  /** The environment this worker was spawned with; the manager diffs it against a new revision. */
  get environment(): NodeJS.ProcessEnv { return this.options.workerEnv }

  /**
   * Apply a settings delta to the live worker. Returns the keys the worker says
   * it applied, so a partial apply is visible to the caller rather than assumed.
   */
  async applySettings(settings: Record<string, string | null>, revision: number): Promise<string[]> {
    if (!this.options.configToken) throw new Error(`local agent ${this.agent.id} has no configuration token`)
    const response = await fetch(`http://127.0.0.1:${this.agent.port}/config/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.configToken}`, "content-type": "application/json" },
      body: JSON.stringify({ revision, settings }),
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.json().catch(() => ({})) as { applied?: unknown; error?: unknown }
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`)
    const applied = Array.isArray(body.applied) ? body.applied.filter((key): key is string => typeof key === "string") : []
    // The worker keeps serving with the new values, so remember them for the next diff.
    for (const [key, value] of Object.entries(settings)) {
      if (!applied.includes(key)) continue
      if (value === null) delete this.options.workerEnv[key]
      else this.options.workerEnv[key] = value
    }
    if (applied.length) this.options.workerEnv.NIRI_CONFIG_REVISION = String(revision)
    return applied
  }

  /** Wait until the current worker has no host RPC lease and is in its idle loop. */
  async waitUntilSafeToApply(timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
    const child = this.child
    if (!child || childExited(child)) return
    if (!this.options.configToken) return
    const deadline = Date.now() + timeoutMs
    let lastError = "worker is busy"
    while (Date.now() < deadline && this.child === child && !childExited(child)) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.agent.port}/config/application-readiness`, {
          headers: { authorization: `Bearer ${this.options.configToken}` }, signal: AbortSignal.timeout(1_000),
        })
        const body = await res.json() as { safeToApply?: unknown; ready?: unknown }
        if (res.ok && (body.safeToApply === true || body.ready === true)) return
        lastError = res.ok ? "worker is busy" : `${res.status} ${res.statusText}`
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new ApplicationNotReadyError(`local agent ${this.agent.id} is not ready to apply config: ${lastError}`)
  }

  async restart(): Promise<void> {
    await this.stop()
    this.startInBackground()
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
    const needsTsx = /\.[cm]?tsx?$/i.test(this.options.workerEntry)
    const child = spawn(process.execPath, needsTsx ? ["--import", "tsx", this.options.workerEntry] : [this.options.workerEntry], {
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
    this.healthyOnce = true
    this.options.onReady(this.agent, instanceId)
  }

  private async waitForHealth(child: ChildProcess, instanceId: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    let lastError = "worker did not answer"
    while (Date.now() < deadline && !childExited(child)) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.agent.port}/health`, { signal: AbortSignal.timeout(1_000) })
        if (res.ok) {
          const body = await res.json()
          if (matchesWorkerIdentity(body, this.agent.id, instanceId) &&
              (this.agent.revision === undefined || (body as { configRevision?: unknown }).configRevision === String(this.agent.revision))) return
          const identity = body && typeof body === "object" ? body as { agentId?: unknown; instanceId?: unknown; configRevision?: unknown } : {}
          lastError = `identity/config mismatch from agent=${String(identity.agentId)} instance=${String(identity.instanceId)} revision=${String(identity.configRevision)}`
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
    this.options.onExit?.()
    if (this.stopping || this.options.autoRestart === false || (!this.healthyOnce && this.options.retryFailedStart === false)) return
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || this.options.autoRestart === false || (!this.healthyOnce && this.options.retryFailedStart === false)) return
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
