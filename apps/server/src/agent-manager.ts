import fs from "node:fs"
import path from "node:path"
import { startConnectionTunnel, type ConnectionTunnel } from "@niri/iroh-transport"
import { resolveAgentSecrets, type AgentConfig, type AgentFile, type WebhookConfig } from "@niri/agent-config"
import { deleteAgent, upsertAgent } from "./control/db"
import { type ConfigStore, type ConfigView } from "./control/config-store"
import { assertNoDuplicateDiscordTokens, buildWorkerEnvironment, resolveConfiguredAgent, type ResolvedLocalAgent } from "./local-agents"
import { ApplicationNotReadyError, LocalAgentSupervisor } from "./supervisor"
import { coldKeys, settingsDelta, type SettingsDelta } from "./control/hot-settings"

export type ManagedAgent = Pick<ConfigView, "id" | "enabled" | "revision" | "application" | "createdAt" | "updatedAt"> & {
  name: string
  model?: { name?: string; provider?: string }
  managed: "local" | "remote"
  running: boolean
  pendingRestartRequired?: boolean
}

type AgentManagerOptions = {
  store: ConfigStore
  repoRoot: string
  workerEntry: string
  controlPort: number
  controlHome: string
  configServerUrl: string
  agentToken: (id: string) => string
  registerAgent?: (agent: { id: string; name: string; baseUrl: string }) => void
  removeAgent?: (id: string) => void
}

type PortAllocations = Record<string, { worker: number; tunnel?: number }>
const portFile = (home: string) => path.join(home, "agent-ports.json")
const clone = <T>(value: T): T => structuredClone(value)

/**
 * Owns the live projection of durable configs. The store is authoritative;
 * maps here are deliberately mutable indexes used by request routing and iroh.
 */
export class AgentManager {
  readonly configuredAgentIds = new Set<string>()
  readonly remoteAgentIds = new Set<string>()
  readonly webhooks = new Map<string, Readonly<Record<string, WebhookConfig>>>()
  readonly supervisors = new Map<string, LocalAgentSupervisor>()
  readonly clientTunnels = new Map<string, ConnectionTunnel>()
  private readonly runningReconciles = new Set<string>()
  private readonly requested = new Map<string, number>()
  private readonly attempted = new Map<string, number>()
  private readonly allocations: PortAllocations
  private closed = false
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly options: AgentManagerOptions) {
    fs.mkdirSync(options.controlHome, { recursive: true, mode: 0o700 })
    try { this.allocations = JSON.parse(fs.readFileSync(portFile(options.controlHome), "utf8")) as PortAllocations } catch { this.allocations = {} }
    for (const item of options.store.list()) this.index(item)
  }

  list(): ManagedAgent[] {
    return this.options.store.list().map((item) => {
      const raw = this.options.store.getRaw(item.id)!
      const remote = raw.worker?.mode === "remote"
      return {
        id: item.id, name: raw.name ?? item.id, enabled: item.enabled, revision: item.revision,
        ...(raw.model ? { model: { ...(raw.model.name ? { name: raw.model.name } : {}), ...(raw.model.provider ? { provider: raw.model.provider } : {}) } } : {}),
        application: item.application, createdAt: item.createdAt, updatedAt: item.updatedAt,
        managed: remote ? "remote" : "local", running: this.supervisors.get(item.id)?.running ?? false,
        ...(remote && item.enabled ? { pendingRestartRequired: true } : {}),
      }
    })
  }

  /** Import legacy YAML's two-range worker/tunnel layout exactly once. */
  reserveLegacy(agents: readonly ResolvedLocalAgent[]): void {
    if (Object.keys(this.allocations).length) return
    for (const agent of agents) this.allocations[agent.id] = { worker: agent.port, ...(agent.clientTunnelPort !== undefined ? { tunnel: agent.clientTunnelPort } : {}) }
    if (agents.length) this.writeAllocations()
  }

  /** Reject fleet collisions before a durable mutation, without reserving ports. */
  validate(config: AgentFile, replacingId?: string): void {
    const candidateId = config.id?.trim() || replacingId
    if (!candidateId) throw new Error("agent id is required")
    const allocations = clone(this.allocations)
    const fleet = this.options.store.list()
      .filter((view) => view.id !== replacingId && view.id !== candidateId)
      .map((view) => this.resolveWith(this.options.store.getRaw(view.id)!, allocations))
    const candidate = this.resolveWith({ ...clone(config), id: candidateId } as AgentConfig, allocations)
    for (const existing of fleet) {
      if (existing.id === candidate.id) throw new Error(`agent ${candidate.id} already exists`)
      if (existing.port === candidate.port) throw new Error(`agents ${existing.id} and ${candidate.id} share worker port ${candidate.port}`)
      if (existing.home === candidate.home) throw new Error(`agents ${existing.id} and ${candidate.id} share home ${candidate.home}`)
      if (existing.clientTunnelPort !== undefined && existing.clientTunnelPort === candidate.clientTunnelPort) throw new Error(`agents ${existing.id} and ${candidate.id} share client tunnel port ${candidate.clientTunnelPort}`)
      if (existing.port === candidate.clientTunnelPort || candidate.port === existing.clientTunnelPort) throw new Error(`agent ${candidate.id} client tunnel port conflicts with ${existing.id} worker port`)
    }
    assertNoDuplicateDiscordTokens([...fleet, candidate])
  }

  /** Refresh control-plane-owned config before a mutation receipt is returned. */
  refresh(id: string): void {
    const view = this.options.store.get(id)
    if (!view) throw new Error(`agent ${id} not found`)
    this.index(view)
  }

  /** Queue a serialized, latest-wins reconciliation without delaying an HTTP mutation. */
  schedule(id: string): void {
    if (this.closed) return
    this.requested.set(id, (this.requested.get(id) ?? 0) + 1)
    if (this.runningReconciles.has(id)) return
    queueMicrotask(() => void this.drain(id))
  }

  private async drain(id: string): Promise<void> {
    if (this.closed || this.runningReconciles.has(id)) return
    this.runningReconciles.add(id)
    let seen = -1
    try {
      while (!this.closed) {
        const generation = this.requested.get(id) ?? 0
        if (generation === seen) break
        seen = generation
        await this.reconcile(id, generation)
      }
    } catch (error) {
      console.error(`[server] reconciliation for ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.runningReconciles.delete(id)
      if (!this.closed && (this.requested.get(id) ?? 0) !== seen) queueMicrotask(() => void this.drain(id))
    }
  }
  private current(id: string, generation: number, revision?: number): boolean {
    const view = this.options.store.get(id)
    return !this.closed && this.requested.get(id) === generation && Boolean(view?.enabled) && (revision === undefined || view?.revision === revision)
  }

  async start(id: string): Promise<ManagedAgent> {
    const view = this.options.store.setEnabled(id, true, { actor: "operator" })
    this.index(view)
    this.attempted.delete(id)
    this.schedule(id)
    return this.one(id)
  }

  async stop(id: string): Promise<ManagedAgent> {
    const view = this.options.store.setEnabled(id, false, { actor: "operator" })
    this.index(view)
    this.attempted.delete(id)
    // Interrupt an idle-readiness wait immediately; it cannot spawn after
    // enabled became false, and reconciliation observes that latest state.
    void this.stopLive(id)
    this.schedule(id)
    return this.one(id)
  }

  async restart(id: string): Promise<ManagedAgent> {
    const view = this.options.store.setEnabled(id, true, { actor: "operator" })
    this.index(view)
    this.attempted.delete(id)
    this.schedule(id)
    return this.one(id)
  }

  /** Boot only enabled durable agents. A failed revision remains failed until an explicit new schedule. */
  startEnabled(): void { for (const item of this.options.store.list()) if (item.enabled) this.schedule(item.id) }

  private register(agent: { id: string; name: string; baseUrl: string }): void { (this.options.registerAgent ?? upsertAgent)(agent) }
  private unregister(id: string): void { (this.options.removeAgent ?? deleteAgent)(id) }

  async close(): Promise<void> {
    this.closed = true
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    await Promise.all([...this.supervisors.keys()].map((id) => this.stopLive(id)))
    await Promise.all([...this.clientTunnels.values()].map((tunnel) => tunnel.close().catch(() => {})))
    this.clientTunnels.clear()
  }

  private one(id: string): ManagedAgent {
    const value = this.list().find((item) => item.id === id)
    if (!value) throw new Error(`agent ${id} not found`)
    return value
  }

  private index(view: ConfigView): void {
    const raw = this.options.store.getRaw(view.id)
    if (!raw) return
    this.configuredAgentIds.add(view.id)
    this.webhooks.set(view.id, resolveAgentSecrets(raw).webhooks ?? {})
    if (raw.worker?.mode === "remote" && view.enabled) this.remoteAgentIds.add(view.id)
    else this.remoteAgentIds.delete(view.id)
  }

  private writeAllocations(): void {
    const file = portFile(this.options.controlHome)
    const pending = `${file}.${process.pid}.tmp`
    fs.writeFileSync(pending, JSON.stringify(this.allocations), { mode: 0o600 })
    fs.renameSync(pending, file)
    fs.chmodSync(file, 0o600)
  }

  private resolveWith(config: AgentConfig, allocations: PortAllocations): ResolvedLocalAgent {
    const id = config.id!
    const prior = allocations[id]
    const occupied = new Set<number>([this.options.controlPort])
    for (const [otherId, item] of Object.entries(allocations)) if (otherId !== id) { occupied.add(item.worker); if (item.tunnel) occupied.add(item.tunnel) }
    let worker = config.port ?? prior?.worker ?? this.options.controlPort + 1
    if (config.port === undefined) while (occupied.has(worker)) worker++
    if (worker > 65535) throw new Error("no worker ports available")
    const allocation = allocations[id] = { ...prior, worker }
    if (config.client === "iroh" && allocation.tunnel === undefined) {
      occupied.add(worker)
      let tunnel = this.options.controlPort + 1
      while (occupied.has(tunnel)) tunnel++
      if (tunnel > 65535) throw new Error("no client tunnel ports available")
      allocation.tunnel = tunnel
    }
    return resolveConfiguredAgent({ ...clone(config), port: worker }, {
      controlPort: this.options.controlPort, repoRoot: this.options.repoRoot, source: `durable config ${id}`,
      ...(allocation.tunnel ? { clientTunnelPort: allocation.tunnel } : {}),
    })
  }

  private resolved(config: AgentConfig, persist = true): ResolvedLocalAgent {
    const before = JSON.stringify(this.allocations)
    const allocations = persist ? this.allocations : clone(this.allocations)
    const agent = this.resolveWith(config, allocations)
    if (persist && JSON.stringify(this.allocations) !== before) this.writeAllocations()
    return agent
  }

  private async reconcile(id: string, generation: number): Promise<void> {
    try {
      const view = this.options.store.get(id)
      if (!view || this.closed) return
      this.index(view)
      const raw = this.options.store.getRaw(id)
      // Once the row is durable, reserve its allocation even while stopped.
      // Validation itself stays pure, so rejected candidates cannot reserve one.
      if (!view.enabled) { if (raw) this.resolved(raw); await this.stopLive(id); return }
      
      if (!raw) return
      if (raw.worker?.mode === "remote") {
        // Do not accept the remote replacement until a former local worker is gone.
        this.remoteAgentIds.delete(id)
        await this.stopLive(id)
        if (!this.closed && this.requested.get(id) === generation && this.options.store.get(id)?.enabled) this.index(this.options.store.get(id)!)
        return
      }
      if (this.attempted.get(id) === view.revision) return
      const current = this.supervisors.get(id)
      await current?.waitUntilSafeToApply()
      if (!this.current(id, generation, view.revision)) return
      this.attempted.set(id, view.revision)
      this.options.store.markApplying(id, view.revision)
      if (current?.running && await this.applyLive(id, current, raw, view.revision)) return
      await this.replaceLocal(id, raw, view.revision, generation)
    } catch (error) {
      const view = this.options.store.get(id)
      if (!view?.enabled || this.closed || this.requested.get(id) !== generation) return
      if (error instanceof ApplicationNotReadyError) {
        // Busy runtime is not a failed revision. Retry lazily and let a newer
        // edit supersede this generation before the timer runs.
        const timer = setTimeout(() => { this.retryTimers.delete(timer); this.schedule(id) }, 1_000)
        timer.unref?.(); this.retryTimers.add(timer)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      try { this.options.store.markFailed(id, message, view.revision) } catch { /* a newer revision won */ }
      console.error(`[server] config revision ${view.revision} for ${id} failed: ${message}`)
    }
  }

  /**
   * Apply a revision to the running worker when every changed setting is hot.
   * Returns false when the revision needs a replacement, so the caller falls
   * back to the path that has always worked.
   */
  /** The exact environment a worker of this revision runs on; spawning and live apply must agree. */
  private workerEnvironment(agent: ResolvedLocalAgent, revision: number): NodeJS.ProcessEnv {
    return {
      ...buildWorkerEnvironment(process.env, agent),
      NIRI_CONFIG_SERVER_URL: this.options.configServerUrl,
      NIRI_CONFIG_TOKEN: this.options.agentToken(agent.id),
      NIRI_CONFIG_REVISION: String(revision),
    }
  }

  private async applyLive(id: string, supervisor: LocalAgentSupervisor, config: AgentConfig, revision: number): Promise<boolean> {
    let delta: SettingsDelta
    try {
      const agent = this.resolved(resolveAgentSecrets(config) as AgentConfig)
      agent.revision = revision
      delta = settingsDelta(supervisor.environment, this.workerEnvironment(agent, revision))
    } catch { return false }
    delete delta.NIRI_CONFIG_REVISION
    const keys = Object.keys(delta)
    if (!keys.length) {
      this.options.store.markActive(id, revision)
      return true
    }
    const cold = coldKeys(delta)
    if (cold.length) return false
    const expected = keys.sort()
    try {
      const applied = [...await supervisor.applySettings(delta, revision)].sort()
      if (applied.length !== expected.length || expected.some((key, index) => key !== applied[index])) {
        const missing = expected.filter((key) => !applied.includes(key))
        this.options.store.markFailed(id, `worker applied ${applied.length} of ${expected.length} settings; missing ${missing.join(", ")}`, revision)
        return true
      }
      this.options.store.markActive(id, revision)
      console.log(`[server] config revision ${revision} for ${id} applied live: ${expected.join(", ")}`)
      return true
    } catch (error) {
      // A failed post is not a failed revision: replacement still owns the outcome.
      console.warn(`[server] live apply for ${id} failed, replacing worker: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private async replaceLocal(id: string, config: AgentConfig, revision: number, generation: number): Promise<void> {
    // Secret refs are resolved only at the spawn/webhook boundary, never persisted.
    const agent = this.resolved(resolveAgentSecrets(config) as AgentConfig)
    agent.revision = revision
    // Keep a compatible iroh tunnel across worker replacement so an attached
    // tool host is not needlessly disconnected. Other transitions close it.
    await this.stopProcess(id)
    this.unregister(id)
    if (agent.client !== "iroh") {
      const oldTunnel = this.clientTunnels.get(id)
      this.clientTunnels.delete(id)
      await oldTunnel?.close().catch(() => {})
    } else if (agent.clientTunnelPort !== undefined && !this.clientTunnels.has(id)) {
      this.clientTunnels.set(id, await startConnectionTunnel(null, { host: "127.0.0.1", port: agent.clientTunnelPort }))
    }
    if (!this.current(id, generation, revision)) return
    const supervisor = new LocalAgentSupervisor({
      agent, repoRoot: this.options.repoRoot, workerEntry: this.options.workerEntry,
      workerEnv: this.workerEnvironment(agent, revision),
      configToken: this.options.agentToken(id),
      autoRestart: true,
      retryFailedStart: false,
      onStartFailure: (error) => {
        if (this.closed || this.supervisors.get(id) !== supervisor || !this.options.store.get(id)?.enabled || this.options.store.get(id)?.revision !== revision) return
        const message = error instanceof Error ? error.message : String(error)
        try { this.options.store.markFailed(id, message, revision) } catch { /* superseded */ }
      },
      onExit: () => {
        this.unregister(id)
        if (this.closed || this.supervisors.get(id) !== supervisor || !this.options.store.get(id)?.enabled || this.options.store.get(id)?.revision !== revision) return
        try { this.options.store.markFailed(id, "worker exited", revision) } catch { /* superseded */ }
      },
      onReady: (ready, _instanceId) => {
        // A stopped/replaced worker must never resurrect an older registration.
        if (this.closed || this.supervisors.get(id) !== supervisor || !this.options.store.get(id)?.enabled || ready.revision !== this.options.store.get(id)?.revision) return
        this.register({ id: ready.id, name: ready.name, baseUrl: `http://127.0.0.1:${ready.port}` })
        try { this.options.store.markActive(id, revision) } catch { /* superseded */ }
      },
    })
    this.supervisors.set(id, supervisor)
    supervisor.startInBackground()
  }

  private async stopProcess(id: string): Promise<void> {
    const supervisor = this.supervisors.get(id)
    this.supervisors.delete(id)
    await supervisor?.stop()
  }

  private async stopLive(id: string): Promise<void> {
    await this.stopProcess(id)
    const tunnel = this.clientTunnels.get(id)
    this.clientTunnels.delete(id)
    await tunnel?.close().catch(() => {})
    this.unregister(id)
  }
}

export type ConfigurationManager = Pick<AgentManager, "list" | "start" | "stop" | "restart" | "refresh" | "schedule" | "validate">
