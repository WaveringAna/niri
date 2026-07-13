import fs from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"

type ProviderConfig = {
  provider?: "openai" | "anthropic"
  name?: string
  baseUrl?: string
  apiKey?: string
  thinking?: boolean
}

type OpenAiProviderConfig = Omit<ProviderConfig, "provider" | "thinking">

type DiscordConfig = {
  token?: string
  enabled?: boolean
  botUserId?: string
  dmWhitelist?: string
  scanChannelIds?: string
  wakeOnEvent?: boolean
}

export type AgentFile = {
  id?: string
  name?: string
  port?: number
  home?: string
  client?: string
  workspace?: string
  model?: ProviderConfig
  fallback?: OpenAiProviderConfig
  embedding?: OpenAiProviderConfig & { dimensions?: number }
  summary?: OpenAiProviderConfig
  discord?: DiscordConfig
  settings?: Record<string, string | number | boolean>
}

export type ResolvedLocalAgent = {
  id: string
  name: string
  port: number
  home: string
  client: string
  workspace?: string
  settings: Record<string, string>
  source: string
}

const AGENT_KEYS = new Set([
  "id",
  "name",
  "port",
  "home",
  "client",
  "workspace",
  "model",
  "fallback",
  "embedding",
  "summary",
  "discord",
  "settings",
])

const RESERVED_SETTINGS = new Set([
  "AGENT_ID",
  "AGENT_NAME",
  "HOME",
  "NIRI_AGENT_ID",
  "NIRI_AGENT_STATE_DIR",
  "NIRI_CLIENT",
  "NIRI_CLIENT_WORKSPACE",
  "NIRI_CONTROL_DB",
  "NIRI_CONTROL_HOME",
  "NIRI_HOME",
  "NIRI_MANAGED_WORKER",
  "NIRI_RESTART_COMMAND",
  "NIRI_RESTART_CWD",
  "NIRI_WORKER_HOST",
  "NIRI_WORKER_INSTANCE_ID",
  "PORT",
])

const SAFE_PARENT_SETTINGS = new Set([
  "COLORTERM",
  "LANG",
  "NO_COLOR",
  "NODE_OPTIONS",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`)
  return value
}

function parseProvider(value: unknown, label: string, allowProvider: boolean, extraKeys: string[] = []): ProviderConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["name", "baseUrl", "apiKey", ...extraKeys, ...(allowProvider ? ["provider", "thinking"] : [])])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const provider = optionalString(item.provider, `${label}.provider`)
  if (provider && provider !== "openai" && provider !== "anthropic") {
    throw new Error(`${label}.provider must be openai or anthropic`)
  }
  return {
    ...(provider ? { provider: provider as ProviderConfig["provider"] } : {}),
    ...(optionalString(item.name, `${label}.name`) ? { name: String(item.name).trim() } : {}),
    ...(optionalString(item.baseUrl, `${label}.baseUrl`) ? { baseUrl: String(item.baseUrl).trim() } : {}),
    ...(optionalString(item.apiKey, `${label}.apiKey`) ? { apiKey: String(item.apiKey).trim() } : {}),
    ...(allowProvider && item.thinking !== undefined ? { thinking: optionalBoolean(item.thinking, `${label}.thinking`) } : {}),
  }
}

function parseDiscord(value: unknown, label: string): DiscordConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["token", "enabled", "botUserId", "dmWhitelist", "scanChannelIds", "wakeOnEvent"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  return {
    ...(optionalString(item.token, `${label}.token`) ? { token: String(item.token).trim() } : {}),
    ...(item.enabled !== undefined ? { enabled: optionalBoolean(item.enabled, `${label}.enabled`) } : {}),
    ...(optionalString(item.botUserId, `${label}.botUserId`) ? { botUserId: String(item.botUserId).trim() } : {}),
    ...(optionalString(item.dmWhitelist, `${label}.dmWhitelist`) ? { dmWhitelist: String(item.dmWhitelist).trim() } : {}),
    ...(optionalString(item.scanChannelIds, `${label}.scanChannelIds`) ? { scanChannelIds: String(item.scanChannelIds).trim() } : {}),
    ...(item.wakeOnEvent !== undefined ? { wakeOnEvent: optionalBoolean(item.wakeOnEvent, `${label}.wakeOnEvent`) } : {}),
  }
}

function parseSettings(value: unknown, label: string): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const result: Record<string, string | number | boolean> = {}
  for (const [key, raw] of Object.entries(item)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`${label}.${key} must use an uppercase runtime setting name`)
    if (
      RESERVED_SETTINGS.has(key) ||
      key.startsWith("NIRI_CLIENT_") ||
      key.startsWith("NIRI_CONTROL_") ||
      key.startsWith("NIRI_TOOL_CLIENT_") ||
      key.startsWith("NIRI_WORKER_")
    ) {
      throw new Error(`${label}.${key} is managed by the server`)
    }
    if (!["string", "number", "boolean"].includes(typeof raw)) throw new Error(`${label}.${key} must be a string, number, or boolean`)
    result[key] = raw as string | number | boolean
  }
  return result
}

export function parseAgentFile(filePath: string): AgentFile {
  let raw: unknown
  try {
    raw = parseYaml(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    throw new Error(`${filePath}: invalid yaml: ${error instanceof Error ? error.message : String(error)}`)
  }
  const item = object(raw, filePath)
  const unknown = Object.keys(item).filter((key) => !AGENT_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${filePath}: unknown keys: ${unknown.join(", ")}`)
  if (item.port !== undefined && (typeof item.port !== "number" || !Number.isInteger(item.port))) {
    throw new Error(`${filePath}: port must be an integer`)
  }

  const embedding = parseProvider(item.embedding, `${filePath}.embedding`, false, ["dimensions"]) as AgentFile["embedding"]
  if (item.embedding && "dimensions" in object(item.embedding, `${filePath}.embedding`)) {
    const dimensions = object(item.embedding, `${filePath}.embedding`).dimensions
    if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1) {
      throw new Error(`${filePath}.embedding.dimensions must be a positive integer`)
    }
    if (embedding) embedding.dimensions = dimensions
  }

  return {
    ...(optionalString(item.id, `${filePath}.id`) ? { id: String(item.id).trim() } : {}),
    ...(optionalString(item.name, `${filePath}.name`) ? { name: String(item.name).trim() } : {}),
    ...(typeof item.port === "number" ? { port: item.port } : {}),
    ...(optionalString(item.home, `${filePath}.home`) ? { home: String(item.home).trim() } : {}),
    ...(optionalString(item.client, `${filePath}.client`) ? { client: String(item.client).trim() } : {}),
    ...(optionalString(item.workspace, `${filePath}.workspace`) ? { workspace: String(item.workspace).trim() } : {}),
    ...(item.model !== undefined ? { model: parseProvider(item.model, `${filePath}.model`, true) } : {}),
    ...(item.fallback !== undefined ? { fallback: parseProvider(item.fallback, `${filePath}.fallback`, false) } : {}),
    ...(embedding ? { embedding } : {}),
    ...(item.summary !== undefined ? { summary: parseProvider(item.summary, `${filePath}.summary`, false) } : {}),
    ...(item.discord !== undefined ? { discord: parseDiscord(item.discord, `${filePath}.discord`) } : {}),
    ...(item.settings !== undefined ? { settings: parseSettings(item.settings, `${filePath}.settings`) } : {}),
  }
}

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

function providerSettings(prefix: string, config: OpenAiProviderConfig | undefined): Record<string, string> {
  if (!config) return {}
  return {
    ...(config.name ? { [`${prefix}MODEL`]: config.name } : {}),
    ...(config.baseUrl ? { [`${prefix}BASE_URL`]: config.baseUrl } : {}),
    ...(config.apiKey ? { [`${prefix}API_KEY`]: config.apiKey } : {}),
  }
}

function agentSettings(config: AgentFile): Record<string, string> {
  const settings: Record<string, string> = {}
  const model = config.model
  if (model?.provider === "anthropic") {
    settings.USE_ANTHROPIC = "true"
    if (model.name) settings.ANTHROPIC_MODEL = model.name
    if (model.baseUrl) settings.ANTHROPIC_BASE_URL = model.baseUrl
    if (model.apiKey) settings.ANTHROPIC_API_KEY = model.apiKey
  } else if (model) {
    settings.USE_ANTHROPIC = "false"
    if (model.name) settings.MODEL = model.name
    if (model.baseUrl) settings.OPENAI_BASE_URL = model.baseUrl
    if (model.apiKey) settings.OPENAI_API_KEY = model.apiKey
  }
  if (model?.thinking !== undefined) settings.ENABLE_THINKING = String(model.thinking)
  Object.assign(settings, providerSettings("FALLBACK_OPENAI_", config.fallback))
  if (config.fallback?.name) {
    settings.FALLBACK_MODEL = config.fallback.name
    delete settings.FALLBACK_OPENAI_MODEL
  }
  Object.assign(settings, providerSettings("EMBEDDING_", config.embedding))
  if (config.embedding?.dimensions) settings.EMBEDDING_DIMENSIONS = String(config.embedding.dimensions)
  Object.assign(settings, providerSettings("SUMMARY_", config.summary))
  if (config.discord?.token) settings.DISCORD_BOT_TOKEN = config.discord.token
  if (config.discord?.enabled !== undefined) settings.DISCORD_GATEWAY_ENABLED = String(config.discord.enabled)
  if (config.discord?.botUserId) settings.DISCORD_BOT_USER_ID = config.discord.botUserId
  if (config.discord?.dmWhitelist) settings.DISCORD_DM_WHITELIST = config.discord.dmWhitelist
  if (config.discord?.scanChannelIds) settings.DISCORD_SCAN_CHANNEL_IDS = config.discord.scanChannelIds
  if (config.discord?.wakeOnEvent !== undefined) settings.DISCORD_WAKE_ON_EVENT = String(config.discord.wakeOnEvent)
  for (const [key, value] of Object.entries(config.settings ?? {})) settings[key] = String(value)
  return settings
}

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
      port,
      home,
      client,
      ...(workspace ? { workspace } : {}),
      settings: agentSettings(config),
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
