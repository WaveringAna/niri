import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type LocalAgentConfig = {
  id: string
  name?: string
  port?: number
  home?: string
  workerToken?: string
  toolClientToken?: string
  expectedClientId?: string
  env?: Record<string, string>
}

export type ResolvedLocalAgent = {
  id: string
  name: string
  port: number
  home: string
  workerToken: string
  toolClientToken?: string
  expectedClientId?: string
  env: Record<string, string>
}

const RESERVED_AGENT_ENV = new Set([
  "AGENT_ID",
  "AGENT_NAME",
  "CONTROL_PORT",
  "HOME",
  "NIRI_AGENT_ID",
  "NIRI_AGENT_STATE_DIR",
  "NIRI_CONTROL_DB",
  "NIRI_CONTROL_HOME",
  "NIRI_CONTROL_TOKEN",
  "NIRI_EXPECTED_CLIENT_ID",
  "NIRI_HOME",
  "NIRI_LOCAL_AGENTS_JSON",
  "NIRI_MANAGED_WORKER",
  "NIRI_RESTART_COMMAND",
  "NIRI_RESTART_CWD",
  "NIRI_TOOL_CLIENT_TOKEN",
  "NIRI_WORKER_HOST",
  "NIRI_WORKER_INSTANCE_ID",
  "NIRI_WORKER_TOKEN",
  "PORT",
])

const LOCAL_AGENT_KEYS = new Set([
  "id",
  "name",
  "port",
  "home",
  "workerToken",
  "toolClientToken",
  "expectedClientId",
  "env",
])

const STRIPPED_PARENT_ENV = new Set([
  ...RESERVED_AGENT_ENV,
  "NIRI_AGENTS",
  "NIRI_AGENTS_JSON",
  "NIRI_AGENT_URL",
])

function parseEnvironment(value: unknown, index: number): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`NIRI_LOCAL_AGENTS_JSON[${index}].env must be an object of strings`)
  }
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error(`NIRI_LOCAL_AGENTS_JSON[${index}].env.${key} must be a string`)
    if (RESERVED_AGENT_ENV.has(key)) throw new Error(`${key} is reserved; configure it on the agent object instead of env`)
    env[key] = item
  }
  return env
}

export function parseLocalAgents(parentEnv: NodeJS.ProcessEnv, controlPort: number): LocalAgentConfig[] {
  const raw = parentEnv.NIRI_LOCAL_AGENTS_JSON?.trim()
  if (!raw) {
    if (parentEnv.NIRI_AGENTS?.trim() || parentEnv.NIRI_AGENTS_JSON?.trim() || parentEnv.NIRI_AGENT_URL?.trim()) return []
    const id = (parentEnv.NIRI_AGENT_ID ?? parentEnv.AGENT_ID ?? "niri").trim() || "niri"
    return [{
      id,
      name: parentEnv.AGENT_NAME?.trim() || id,
      port: Number.parseInt(parentEnv.NIRI_WORKER_PORT ?? `${controlPort + 1}`, 10),
      home: parentEnv.NIRI_HOME,
      workerToken: parentEnv.NIRI_WORKER_TOKEN,
      toolClientToken: parentEnv.NIRI_TOOL_CLIENT_TOKEN,
      expectedClientId: parentEnv.NIRI_EXPECTED_CLIENT_ID,
      env: {
        NIRI_MIGRATE_LEGACY_STATE: parentEnv.NIRI_MIGRATE_LEGACY_STATE?.trim() || "true",
      },
    }]
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`NIRI_LOCAL_AGENTS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error("NIRI_LOCAL_AGENTS_JSON must be an array")

  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`NIRI_LOCAL_AGENTS_JSON[${index}] must be an object`)
    }
    const item = value as Record<string, unknown>
    const unknownKeys = Object.keys(item).filter((key) => !LOCAL_AGENT_KEYS.has(key))
    if (unknownKeys.length > 0) {
      throw new Error(`NIRI_LOCAL_AGENTS_JSON[${index}] has unknown keys: ${unknownKeys.join(", ")}`)
    }
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid local agent id at index ${index}`)
    if (item.port !== undefined && (typeof item.port !== "number" || !Number.isInteger(item.port))) {
      throw new Error(`NIRI_LOCAL_AGENTS_JSON[${index}].port must be an integer`)
    }
    const env = parseEnvironment(item.env, index)
    return {
      id,
      ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(typeof item.port === "number" ? { port: item.port } : {}),
      ...(typeof item.home === "string" && item.home.trim() ? { home: item.home.trim() } : {}),
      ...(typeof item.workerToken === "string" && item.workerToken.trim() ? { workerToken: item.workerToken.trim() } : {}),
      ...(typeof item.toolClientToken === "string" && item.toolClientToken.trim() ? { toolClientToken: item.toolClientToken.trim() } : {}),
      ...(typeof item.expectedClientId === "string" && item.expectedClientId.trim() ? { expectedClientId: item.expectedClientId.trim() } : {}),
      ...(env ? { env } : {}),
    }
  })
}

export function resolveLocalAgents(
  configs: LocalAgentConfig[],
  options: { controlPort: number; repoRoot: string; controlToken?: string; token?: () => string },
): ResolvedLocalAgent[] {
  const createToken = options.token ?? (() => randomBytes(32).toString("base64url"))
  const resolved = configs.map((config, index) => {
    const port = config.port ?? options.controlPort + index + 1
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid worker port for ${config.id}`)
    if (port === options.controlPort) throw new Error(`worker ${config.id} cannot use control port ${options.controlPort}`)
    const configuredHome = config.home
      ? (path.isAbsolute(config.home) ? config.home : path.join(options.repoRoot, config.home))
      : path.join(options.repoRoot, "data", "agents", config.id)
    return {
      id: config.id,
      name: config.name ?? config.id,
      port,
      home: canonicalPath(configuredHome),
      workerToken: config.workerToken?.trim() || createToken(),
      ...(config.toolClientToken?.trim() ? { toolClientToken: config.toolClientToken.trim() } : {}),
      ...(config.expectedClientId ? { expectedClientId: config.expectedClientId } : {}),
      env: { ...(config.env ?? {}) },
    }
  })

  assertUnique(resolved, "id", (agent) => agent.id)
  assertUnique(resolved, "port", (agent) => String(agent.port))
  assertUnique(resolved, "home", (agent) => agent.home)
  assertUniqueCredentials(resolved)
  const controlToken = options.controlToken?.trim()
  if (controlToken && resolved.some((agent) => agent.workerToken === controlToken || agent.toolClientToken === controlToken)) {
    throw new Error("control and agent credentials must be distinct")
  }
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
  const canonicalParent = fs.realpathSync.native(current)
  return path.join(canonicalParent, ...suffix)
}

function assertUnique<T>(items: T[], label: string, key: (item: T) => string): void {
  const owners = new Map<string, number>()
  items.forEach((item, index) => {
    const value = key(item)
    const prior = owners.get(value)
    if (prior !== undefined) throw new Error(`local agents at indexes ${prior} and ${index} share ${label}`)
    owners.set(value, index)
  })
}

function assertUniqueCredentials(agents: ResolvedLocalAgent[]): void {
  const owners = new Map<string, { agent: string; role: string }>()
  for (const agent of agents) {
    for (const [role, value] of [["worker", agent.workerToken], ["tool client", agent.toolClientToken]] as const) {
      if (!value) continue
      const prior = owners.get(value)
      if (prior) {
        throw new Error(`agents ${prior.agent} and ${agent.id} reuse a credential across ${prior.role} and ${role} roles`)
      }
      owners.set(value, { agent: agent.id, role })
    }
  }
}

export function assertNoDuplicateDiscordTokens(agents: ResolvedLocalAgent[], parentEnv: NodeJS.ProcessEnv): void {
  const owners = new Map<string, string>()
  for (const agent of agents) {
    const token = ("DISCORD_BOT_TOKEN" in agent.env ? agent.env.DISCORD_BOT_TOKEN : parentEnv.DISCORD_BOT_TOKEN)?.trim()
    if (!token) continue
    const prior = owners.get(token)
    if (prior) throw new Error(`agents ${prior} and ${agent.id} share DISCORD_BOT_TOKEN`)
    owners.set(token, agent.id)
  }
}

export function assertNoDuplicateBridgePorts(
  agents: ResolvedLocalAgent[],
  parentEnv: NodeJS.ProcessEnv,
  controlPort: number,
): void {
  const owners = new Map<number, string>()
  const workerPorts = new Map(agents.map((agent) => [agent.port, agent.id]))
  for (const agent of agents) {
    for (const bridge of [
      { name: "Antigravity", enabled: "ANTIGRAVITY_BRIDGE_ENABLED", port: "ANTIGRAVITY_BRIDGE_PORT", fallback: "8000" },
      { name: "Codex", enabled: "CODEX_BRIDGE_ENABLED", port: "CODEX_BRIDGE_PORT", fallback: "8001" },
    ] as const) {
      const enabled = (agent.env[bridge.enabled] ?? parentEnv[bridge.enabled])?.trim().toLowerCase() === "true"
      if (!enabled) continue
      const port = Number.parseInt(agent.env[bridge.port] ?? parentEnv[bridge.port] ?? bridge.fallback, 10)
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

export function buildWorkerEnvironment(parentEnv: NodeJS.ProcessEnv, agent: ResolvedLocalAgent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv }
  for (const key of STRIPPED_PARENT_ENV) delete env[key]
  Object.assign(env, agent.env, {
    HOME: agent.home,
    NIRI_AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    NIRI_HOME: agent.home,
    PORT: String(agent.port),
    NIRI_WORKER_HOST: "127.0.0.1",
    NIRI_WORKER_TOKEN: agent.workerToken,
    NIRI_MANAGED_WORKER: "true",
  })
  if (!("NIRI_MIGRATE_LEGACY_STATE" in agent.env)) env.NIRI_MIGRATE_LEGACY_STATE = "false"
  if (agent.toolClientToken) env.NIRI_TOOL_CLIENT_TOKEN = agent.toolClientToken
  if (agent.expectedClientId) env.NIRI_EXPECTED_CLIENT_ID = agent.expectedClientId
  return env
}
