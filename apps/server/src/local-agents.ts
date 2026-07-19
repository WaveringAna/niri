import fs from "node:fs"
import path from "node:path"
import {
  AGENT_KEYS,
  SAFE_PARENT_SETTINGS,
  agentSettings,
  parseAgentFile,
  type AgentFile,
  type WebhookConfig,
} from "@niri/agent-config"

/** Resolved agent ready to be supervised by the control plane. */
export type ResolvedLocalAgent = {
  id: string
  name: string
  port: number
  home: string
  client: string
  workspace?: string
  /** Whether the control plane spawns this worker (`local`) or waits for an iroh dial-in (`remote`). */
  workerMode: "local" | "remote"
  settings: Record<string, string>
  webhooks: Record<string, WebhookConfig>
  source: string
}

export {
  AGENT_KEYS,
  type AgentFile,
  type WebhookConfig,
  parseAgentFile,
  agentSettings,
}

/**
 * Read every `.yml`/`.yaml` file (skipping `.example.*`) in `directory` and
 * parse each into an {@link AgentFile}. Throws if the directory is missing or
 * contains no agent yaml files.
 */
export function loadAgentFiles(directory: string): Array<{ config: AgentFile; source: string }> {
  if (!fs.existsSync(directory)) throw new Error(`agent directory does not exist: ${directory}`)
  const files = fs.readdirSync(directory)
    .filter((name) => /\.ya?ml$/i.test(name) && !/\.example\.ya?ml$/i.test(name))
    .sort()
  if (files.length === 0) throw new Error(`no agent yaml files found in ${directory}`)
  return files.map((name) => {
    const source = path.join(directory, name)
    return { config: parseAgentFile(source), source }
  })
}

/**
 * Validate `id`, allocate worker ports, resolve `home`/`workspace` paths, and
 * apply the `client` requirement for each parsed {@link AgentFile}. Returns the
 * full {@link ResolvedLocalAgent} list ready for supervision.
 */
export function resolveLocalAgents(
  files: Array<{ config: AgentFile; source: string }>,
  options: { controlPort: number; repoRoot: string },
): ResolvedLocalAgent[] {
  const resolved = files.map(({ config, source }, index) => {
    const id = (config.id ?? path.basename(source).replace(/\.ya?ml$/i, "")).trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${source}: invalid agent id ${id}`)
    const port = config.port ?? options.controlPort + index + 1
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === options.controlPort) {
      throw new Error(`${source}: invalid worker port ${port}`)
    }
    const home = canonicalPath(config.home
      ? (path.isAbsolute(config.home) ? config.home : path.join(options.repoRoot, config.home))
      : path.join(options.repoRoot, "data", "agents", id))
    const client = config.client?.trim()
    if (!client) throw new Error(`${source}: client is required`)
    if (client !== "local") {
      const url = new URL(client)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${source}: client must be local or an HTTP(S) URL without credentials`)
      }
    }
    const workspace = config.workspace
      ? canonicalPath(path.isAbsolute(config.workspace) ? config.workspace : path.join(options.repoRoot, config.workspace))
      : undefined
    return {
      id,
      name: config.name ?? id,
      workerMode: (config.worker?.mode === "remote" ? "remote" : "local") as "local" | "remote",
      port,
      home,
      client,
      ...(workspace ? { workspace } : {}),
      settings: agentSettings(config),
      webhooks: config.webhooks ?? {},
      source,
    }
  })

  assertUnique(resolved, "id", (agent) => agent.id)
  assertUnique(resolved, "port", (agent) => String(agent.port))
  assertUnique(resolved, "home", (agent) => agent.home)
  return resolved
}

function canonicalPath(value: string): string {
  const suffix: string[] = []
  let current = path.resolve(value)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync.native(current), ...suffix)
}

function assertUnique<T>(items: T[], label: string, key: (item: T) => string): void {
  const owners = new Map<string, number>()
  items.forEach((item, index) => {
    const value = key(item)
    const prior = owners.get(value)
    if (prior !== undefined) throw new Error(`agents at indexes ${prior} and ${index} share ${label}`)
    owners.set(value, index)
  })
}

/**
 * Reject Discord bot tokens shared by two resolved agents. The control plane
 * calls this once after {@link resolveLocalAgents}.
 */
export function assertNoDuplicateDiscordTokens(agents: ResolvedLocalAgent[]): void {
  const owners = new Map<string, string>()
  for (const agent of agents) {
    const token = agent.settings.DISCORD_BOT_TOKEN?.trim()
    if (!token) continue
    const prior = owners.get(token)
    if (prior) throw new Error(`agents ${prior} and ${agent.id} share DISCORD_BOT_TOKEN`)
    owners.set(token, agent.id)
  }
}

/**
 * Reject Antigravity/Codex bridge ports that collide with each other, the
 * control plane, or any worker port. The control plane calls this once after
 * {@link resolveLocalAgents}.
 */
export function assertNoDuplicateBridgePorts(agents: ResolvedLocalAgent[], controlPort: number): void {
  const owners = new Map<number, string>()
  const workerPorts = new Map(agents.map((agent) => [agent.port, agent.id]))
  for (const agent of agents) {
    for (const bridge of [
      { name: "Antigravity", enabled: "ANTIGRAVITY_BRIDGE_ENABLED", port: "ANTIGRAVITY_BRIDGE_PORT", fallback: "8000" },
      { name: "Codex", enabled: "CODEX_BRIDGE_ENABLED", port: "CODEX_BRIDGE_PORT", fallback: "8001" },
    ] as const) {
      if (agent.settings[bridge.enabled]?.trim().toLowerCase() !== "true") continue
      const port = Number.parseInt(agent.settings[bridge.port] ?? bridge.fallback, 10)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${bridge.name} bridge port for ${agent.id}`)
      const workerOwner = workerPorts.get(port)
      if (port === controlPort || workerOwner) {
        throw new Error(`${bridge.name} bridge port ${port} conflicts with ${port === controlPort ? "the control plane" : `worker ${workerOwner}`}`)
      }
      const owner = `${agent.id} ${bridge.name}`
      const prior = owners.get(port)
      if (prior) throw new Error(`${prior} and ${owner} bridges share port ${port}`)
      owners.set(port, owner)
    }
  }
}

/**
 * Compose the worker process environment from the parent process's safe subset
 * plus the agent's flattened settings. Used by the supervisor when spawning a
 * managed local worker.
 */
export function buildWorkerEnvironment(parentEnv: NodeJS.ProcessEnv, agent: ResolvedLocalAgent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SAFE_PARENT_SETTINGS.has(key) || key.startsWith("LC_")) env[key] = value
  }
  Object.assign(env, agent.settings, {
    HOME: agent.home,
    NIRI_AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    NIRI_HOME: agent.home,
    NIRI_CLIENT: agent.client,
    ...(agent.workspace ? { NIRI_CLIENT_WORKSPACE: agent.workspace } : {}),
    PORT: String(agent.port),
    NIRI_WORKER_HOST: "127.0.0.1",
    NIRI_MANAGED_WORKER: "true",
    NIRI_MIGRATE_LEGACY_STATE: agent.settings.NIRI_MIGRATE_LEGACY_STATE ?? "false",
  })
  return env
}
