/**
 * Agent YAML parsing shared by the control plane (apps/server) and standalone
 * workers (packages/niri-runtime). The control plane additionally resolves
 * ports, identities, and homes for the agents it supervises; standalone workers
 * only need the field parsers to hydrate their environment.
 *
 * @module @niri/agent-config
 */

import fs from "node:fs"
import { parse as parseYaml } from "yaml"

/** Model provider configuration (top-level `model`, also reused by `fallback`, `embedding`, `summary`). */
/** A secret is either inline (legacy/imported configs) or resolved by the operator at runtime. */
export type SecretRef = { env: string } | { file: string }
export type SecretValue = string | SecretRef
export type AgentSecrets = Record<string, SecretRef>

export type ProviderConfig = {
  provider?: "openai" | "anthropic"
  name?: string
  baseUrl?: string
  apiKey?: string
  thinking?: boolean
}

/** Provider shape without the discriminator fields used by auxiliary providers. */
export type OpenAiProviderConfig = Omit<ProviderConfig, "provider" | "thinking">

/**
 * Wording for one posture. The runtime owns the mechanism; the agent owns the
 * words, so nothing here is persona the code invents on its behalf.
 */
export type PostureWording = {
  /** What the posture is, in the agent's voice; shown in the posture tool. */
  description?: string
  /** When to choose it; shown in the posture tool as its own sentence. */
  guidance?: string
  /** Discord status text while the posture is held. */
  bio?: string
  /** Nudge sent when the posture has been held long enough to check the queue. */
  reminder?: string
}

/** First-party `discord:` block. */
export type DiscordConfig = {
  token?: string
  enabled?: boolean
  botUserId?: string
  dmWhitelist?: string
  /** Keyed by posture name; `hearth` and `forge` drive the runtime, others are wording only. */
  postures?: Record<string, PostureWording>
  posture_bypass?: {
    users?: string[]
    channels?: string[]
  }
  scanChannelIds?: string
  wakeOnEvent?: boolean
  gatewayTrace?: boolean
  gatewayRawFallback?: boolean
  batchIntervalMs?: number
  batchOnlyConfigured?: boolean
  pendingAutoSeenMinutes?: number
  batchScan?: boolean
  batchMaxMessages?: number
  cooldownChannels?: string
  cooldownTz?: string
  gastownForumChannelId?: string
}

export type DelegationProfileConfig = {
  name: string
  model?: string
  systemPrompt?: string
  tools: Array<"shell" | "read_file" | "write_file" | "edit_file" | "image_tool">
  mcpTools?: string[]
  maxTurns?: number
}

export type DelegationConfig = {
  enabled?: boolean
  maxConcurrent?: number
  timeoutMs?: number
  resultMaxChars?: number
  profiles: DelegationProfileConfig[]
}

/** Named webhook endpoint configuration. */
export type WebhookConfig = {
  secret: string
  signatureHeader?: string
  signaturePrefix?: string
}

/** First-party `runtime:` block. */
export type RuntimeConfig = {
  imageMaxBytes?: number
  primaryToolChoice?: "required" | "auto" | "none"
  fallbackToolChoice?: "required" | "auto" | "none"
  fallbackEnforceContextLimit?: boolean
  contextCompactTriggerTokens?: number
  contextCompactHardTriggerTokens?: number
  contextCompactMinNewMessages?: number
  lcmSummaryBatchSize?: number
  migrateLegacyState?: boolean
}

/** First-party `mcp:` server entry. */
export type McpServerConfig = {
  url?: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  auth?:
    | { type: "bearer"; token: string }
    | { type: "basic"; username: string; password: string }
}

/** First-party `server.iroh:` block — credentials a remote worker uses to dial the control plane. */
export type ServerIrohConfig = {
  /** EndpointTicket (base32) of the control plane's iroh endpoint. */
  ticket?: string
  /** Shared bearer token authenticating the worker at dial-in. */
  token?: string
}

/** First-party `server:` block. */
export type ServerConfig = {
  iroh?: ServerIrohConfig
}

/** Worker placement hint read by the control plane. */
export type WorkerConfig = {
  /** `"local"` (default) — the control plane spawns a supervised worker. `"remote"` — wait for an iroh dial-in. */
  mode?: "local" | "remote"
}

/** Parsed contents of a single agent yaml file. */
export type ConfigPolicy = {
  selfEdit?: boolean
  /** Dot paths an agent may edit. Defaults to behavioral blocks only. */
  allowedPaths?: string[]
  /** Operator values that an edit must retain. */
  enforcedPaths?: string[]
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
  delegation?: DelegationConfig
  webhooks?: Record<string, WebhookConfig>
  runtime?: RuntimeConfig
  mcp?: Record<string, McpServerConfig>
  server?: ServerConfig
  worker?: WorkerConfig
  settings?: Record<string, string | number | boolean>
  /** Secret references keyed by target field, e.g. { "model.apiKey": { env: "OPENAI_API_KEY" } }. */
  secrets?: AgentSecrets
}

export type AgentConfig = AgentFile & { configPolicy: ConfigPolicy }

/** Top-level keys we accept in an agent yaml file. */
export const AGENT_KEYS = new Set<string>([
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
  "delegation",
  "webhooks",
  "runtime",
  "mcp",
  "server",
  "worker",
  "settings",
  "configPolicy",
  "secrets",
])

/** Runtime setting names managed by the server itself; rejected in user-supplied `settings:`. */
export const RESERVED_SETTINGS = new Set<string>([
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
  "NIRI_MCP_CONFIG",
  "NIRI_DELEGATION_CONFIG",
  "NIRI_CONFIG_SERVER_URL",
  "NIRI_CONFIG_SERVER_TOKEN",
  "NIRI_CONFIG_REVISION",
  "DISCORD_GASTOWN_FORUM_CHANNEL_ID",
  "NIRI_RESTART_COMMAND",
  "NIRI_RESTART_CWD",
  "NIRI_WORKER_HOST",
  "NIRI_WORKER_INSTANCE_ID",
  "PORT",
])

/** Host environment variables safe to inherit into a managed worker. */
export const SAFE_PARENT_SETTINGS = new Set<string>([
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

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const item = value as Record<string, unknown>
  if (!([Object.prototype, null] as unknown[]).includes(Object.getPrototypeOf(value))) throw new Error(`${label} must not have a custom prototype`)
  const dangerous = Object.keys(item).filter((key) => DANGEROUS_KEYS.has(key))
  if (dangerous.length) throw new Error(`${label} contains unsafe keys: ${dangerous.join(", ")}`)
  return item
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalSensitiveString(value: unknown, label: string): string | undefined {
  const result = optionalString(value, label)
  if (result === "[redacted]") throw new Error(`${label} is redacted; use an operator-provided value or secrets reference`)
  return result
}

function optionalSecret(value: unknown, label: string): SecretValue | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return optionalString(value, label)
  const item = object(value, label)
  const keys = Object.keys(item)
  if (keys.length !== 1 || (keys[0] !== "env" && keys[0] !== "file")) throw new Error(`${label} must be a string or { env: string } or { file: string }`)
  const ref = optionalString(item[keys[0]], `${label}.${keys[0]}`)
  if (!ref) throw new Error(`${label}.${keys[0]} is required`)
  return keys[0] === "env" ? { env: ref } : { file: ref }
}

/** Resolve explicit secret references only at the process boundary. */
export function resolveSecret(value: SecretValue | undefined, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if ("env" in value) return environment[value.env]
  try { return fs.readFileSync(value.file, "utf8").trim() } catch { return undefined }
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`)
  return value
}

function optionalInteger(value: unknown, label: string, minimum = 1): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return value
}

function optionalSnowflakeList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null
  if (!values || values.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of Discord ids or a comma-separated string`)
  }
  const result = values.map((item) => item.trim()).filter(Boolean)
  if (result.some((item) => !/^\d+$/.test(item))) throw new Error(`${label} must contain Discord snowflake ids`)
  return result
}

function optionalChoice(value: unknown, label: string): "required" | "auto" | "none" | undefined {
  const choice = optionalString(value, label)
  if (choice === undefined) return undefined
  if (choice !== "required" && choice !== "auto" && choice !== "none") throw new Error(`${label} must be required, auto, or none`)
  return choice
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
    ...(optionalSensitiveString(item.apiKey, `${label}.apiKey`) ? { apiKey: optionalSensitiveString(item.apiKey, `${label}.apiKey`)! } : {}),
    ...(allowProvider && item.thinking !== undefined ? { thinking: optionalBoolean(item.thinking, `${label}.thinking`) } : {}),
  }
}

const POSTURE_NAME = /^[a-z0-9_-]+$/
const POSTURE_TEXT_LIMIT = 2000
const POSTURE_FIELDS = ["description", "guidance", "bio", "reminder"] as const

/** Free-form posture names so an agent can invent postures; the wording fields are fixed. */
function parsePostures(value: unknown, label: string): Record<string, PostureWording> | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const postures: Record<string, PostureWording> = {}
  for (const [name, raw] of Object.entries(item)) {
    if (!POSTURE_NAME.test(name)) throw new Error(`${label} name ${name} must match ${POSTURE_NAME.source}`)
    const fields = object(raw, `${label}.${name}`)
    const unknown = Object.keys(fields).filter((key) => !POSTURE_FIELDS.includes(key as typeof POSTURE_FIELDS[number]))
    if (unknown.length > 0) throw new Error(`${label}.${name} has unknown keys: ${unknown.join(", ")}`)
    const wording: PostureWording = {}
    for (const field of POSTURE_FIELDS) {
      const text = optionalString(fields[field], `${label}.${name}.${field}`)
      if (text === undefined) continue
      if (text.length > POSTURE_TEXT_LIMIT) throw new Error(`${label}.${name}.${field} must be at most ${POSTURE_TEXT_LIMIT} characters`)
      wording[field] = text
    }
    if (Object.keys(wording).length > 0) postures[name] = wording
  }
  return Object.keys(postures).length > 0 ? postures : undefined
}

function parseDiscord(value: unknown, label: string): DiscordConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["token", "enabled", "botUserId", "dmWhitelist", "postures", "posture_bypass", "scanChannelIds", "wakeOnEvent", "gatewayTrace", "gatewayRawFallback", "batchIntervalMs", "batchOnlyConfigured", "pendingAutoSeenMinutes", "batchScan", "batchMaxMessages", "cooldownChannels", "cooldownTz", "gastownForumChannelId"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const postureBypass = item.posture_bypass === undefined ? undefined : object(item.posture_bypass, `${label}.posture_bypass`)
  if (postureBypass) {
    const postureUnknown = Object.keys(postureBypass).filter((key) => !["users", "channels"].includes(key))
    if (postureUnknown.length > 0) throw new Error(`${label}.posture_bypass has unknown keys: ${postureUnknown.join(", ")}`)
  }
  const postures = parsePostures(item.postures, `${label}.postures`)
  const postureUsers = postureBypass ? optionalSnowflakeList(postureBypass.users, `${label}.posture_bypass.users`) : undefined
  const postureChannels = postureBypass ? optionalSnowflakeList(postureBypass.channels, `${label}.posture_bypass.channels`) : undefined
  return {
    ...(optionalSensitiveString(item.token, `${label}.token`) ? { token: optionalSensitiveString(item.token, `${label}.token`)! } : {}),
    ...(item.enabled !== undefined ? { enabled: optionalBoolean(item.enabled, `${label}.enabled`) } : {}),
    ...(optionalString(item.botUserId, `${label}.botUserId`) ? { botUserId: String(item.botUserId).trim() } : {}),
    ...(optionalString(item.dmWhitelist, `${label}.dmWhitelist`) ? { dmWhitelist: String(item.dmWhitelist).trim() } : {}),
    ...(postures ? { postures } : {}),
    ...(postureBypass
      ? {
          posture_bypass: {
            ...(postureUsers !== undefined ? { users: postureUsers } : {}),
            ...(postureChannels !== undefined ? { channels: postureChannels } : {}),
          },
        }
      : {}),
    ...(optionalString(item.scanChannelIds, `${label}.scanChannelIds`) ? { scanChannelIds: String(item.scanChannelIds).trim() } : {}),
    ...(item.wakeOnEvent !== undefined ? { wakeOnEvent: optionalBoolean(item.wakeOnEvent, `${label}.wakeOnEvent`) } : {}),
    ...(item.gatewayTrace !== undefined ? { gatewayTrace: optionalBoolean(item.gatewayTrace, `${label}.gatewayTrace`) } : {}),
    ...(item.gatewayRawFallback !== undefined ? { gatewayRawFallback: optionalBoolean(item.gatewayRawFallback, `${label}.gatewayRawFallback`) } : {}),
    ...(item.batchIntervalMs !== undefined ? { batchIntervalMs: optionalInteger(item.batchIntervalMs, `${label}.batchIntervalMs`) } : {}),
    ...(item.batchOnlyConfigured !== undefined ? { batchOnlyConfigured: optionalBoolean(item.batchOnlyConfigured, `${label}.batchOnlyConfigured`) } : {}),
    ...(item.pendingAutoSeenMinutes !== undefined ? { pendingAutoSeenMinutes: optionalInteger(item.pendingAutoSeenMinutes, `${label}.pendingAutoSeenMinutes`) } : {}),
    ...(item.batchScan !== undefined ? { batchScan: optionalBoolean(item.batchScan, `${label}.batchScan`) } : {}),
    ...(item.batchMaxMessages !== undefined ? { batchMaxMessages: optionalInteger(item.batchMaxMessages, `${label}.batchMaxMessages`) } : {}),
    ...(optionalString(item.cooldownChannels, `${label}.cooldownChannels`) ? { cooldownChannels: String(item.cooldownChannels).trim() } : {}),
    ...(optionalString(item.cooldownTz, `${label}.cooldownTz`) ? { cooldownTz: String(item.cooldownTz).trim() } : {}),
    ...(optionalString(item.gastownForumChannelId, `${label}.gastownForumChannelId`) ? { gastownForumChannelId: String(item.gastownForumChannelId).trim() } : {}),
  }
}

function parseDelegation(value: unknown, label: string): DelegationConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["enabled", "maxConcurrent", "timeoutMs", "resultMaxChars", "profiles"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)

  const rawProfiles = item.profiles ?? []
  if (!Array.isArray(rawProfiles)) throw new Error(`${label}.profiles must be an array`)
  const knownTools = new Set(["shell", "read_file", "write_file", "edit_file", "image_tool"])
  const names = new Set<string>()
  const profiles = rawProfiles.map((raw, index): DelegationProfileConfig => {
    const profileLabel = `${label}.profiles[${index}]`
    const profile = object(raw, profileLabel)
    const profileUnknown = Object.keys(profile).filter((key) => !["name", "model", "systemPrompt", "tools", "mcpTools", "maxTurns"].includes(key))
    if (profileUnknown.length > 0) throw new Error(`${profileLabel} has unknown keys: ${profileUnknown.join(", ")}`)
    const name = optionalString(profile.name, `${profileLabel}.name`)
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${profileLabel}.name must match [a-zA-Z0-9_-]+`)
    if (names.has(name)) throw new Error(`${label}.profiles has duplicate name ${name}`)
    names.add(name)
    if (!Array.isArray(profile.tools) || profile.tools.length === 0 || profile.tools.some((tool) => typeof tool !== "string" || !knownTools.has(tool))) {
      throw new Error(`${profileLabel}.tools must be a non-empty array of shell, read_file, write_file, edit_file, or image_tool`)
    }
    let mcpTools: string[] | undefined
    if (profile.mcpTools !== undefined) {
      if (!Array.isArray(profile.mcpTools) || profile.mcpTools.length === 0 || profile.mcpTools.some((tool) => typeof tool !== "string" || !/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(tool) || tool.length > 64)) {
        throw new Error(`${profileLabel}.mcpTools must be a non-empty array of namespaced MCP tool names`)
      }
      mcpTools = [...new Set(profile.mcpTools)] as string[]
    }
    return {
      name,
      ...(profile.model !== undefined ? { model: optionalString(profile.model, `${profileLabel}.model`) } : {}),
      tools: [...new Set(profile.tools)] as DelegationProfileConfig["tools"],
      ...(mcpTools ? { mcpTools } : {}),
      ...(profile.systemPrompt !== undefined ? { systemPrompt: optionalString(profile.systemPrompt, `${profileLabel}.systemPrompt`) } : {}),
      ...(profile.maxTurns !== undefined ? { maxTurns: optionalInteger(profile.maxTurns, `${profileLabel}.maxTurns`) } : {}),
    }
  })

  return {
    profiles,
    ...(item.enabled !== undefined ? { enabled: optionalBoolean(item.enabled, `${label}.enabled`) } : {}),
    ...(item.maxConcurrent !== undefined ? { maxConcurrent: optionalInteger(item.maxConcurrent, `${label}.maxConcurrent`) } : {}),
    ...(item.timeoutMs !== undefined ? { timeoutMs: optionalInteger(item.timeoutMs, `${label}.timeoutMs`, 1000) } : {}),
    ...(item.resultMaxChars !== undefined ? { resultMaxChars: optionalInteger(item.resultMaxChars, `${label}.resultMaxChars`, 1000) } : {}),
  }
}

function parseWebhooks(value: unknown, label: string, secrets?: AgentSecrets): Record<string, WebhookConfig> | undefined {
  if (value === undefined) return undefined
  const entries = object(value, label)
  const result: Record<string, WebhookConfig> = {}
  for (const [name, raw] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${label}.${name} has an invalid webhook name`)
    const item = object(raw, `${label}.${name}`)
    const unknown = Object.keys(item).filter((key) => !["secret", "signatureHeader", "signaturePrefix"].includes(key))
    if (unknown.length > 0) throw new Error(`${label}.${name} has unknown keys: ${unknown.join(", ")}`)
    const secret = optionalSensitiveString(item.secret, `${label}.${name}.secret`)
    if (!secret && !secrets?.[`webhooks.${name}.secret`]) throw new Error(`${label}.${name}.secret is required unless supplied by secrets`)
    const signatureHeader = optionalString(item.signatureHeader, `${label}.${name}.signatureHeader`)
    if (signatureHeader && !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(signatureHeader)) {
      throw new Error(`${label}.${name}.signatureHeader must be an HTTP header name`)
    }
    if (item.signaturePrefix !== undefined && typeof item.signaturePrefix !== "string") {
      throw new Error(`${label}.${name}.signaturePrefix must be a string`)
    }
    result[name] = {
      ...(secret ? { secret } : {}),
      ...(signatureHeader ? { signatureHeader: signatureHeader.toLowerCase() } : {}),
      ...(typeof item.signaturePrefix === "string" ? { signaturePrefix: item.signaturePrefix } : {}),
    } as WebhookConfig
  }
  return result
}

function parseRuntime(value: unknown, label: string): RuntimeConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["imageMaxBytes", "primaryToolChoice", "fallbackToolChoice", "fallbackEnforceContextLimit", "contextCompactTriggerTokens", "contextCompactHardTriggerTokens", "contextCompactMinNewMessages", "lcmSummaryBatchSize", "migrateLegacyState"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  return {
    ...(item.imageMaxBytes !== undefined ? { imageMaxBytes: optionalInteger(item.imageMaxBytes, `${label}.imageMaxBytes`) } : {}),
    ...(item.primaryToolChoice !== undefined ? { primaryToolChoice: optionalChoice(item.primaryToolChoice, `${label}.primaryToolChoice`) } : {}),
    ...(item.fallbackToolChoice !== undefined ? { fallbackToolChoice: optionalChoice(item.fallbackToolChoice, `${label}.fallbackToolChoice`) } : {}),
    ...(item.fallbackEnforceContextLimit !== undefined ? { fallbackEnforceContextLimit: optionalBoolean(item.fallbackEnforceContextLimit, `${label}.fallbackEnforceContextLimit`) } : {}),
    ...(item.contextCompactTriggerTokens !== undefined ? { contextCompactTriggerTokens: optionalInteger(item.contextCompactTriggerTokens, `${label}.contextCompactTriggerTokens`) } : {}),
    ...(item.contextCompactHardTriggerTokens !== undefined ? { contextCompactHardTriggerTokens: optionalInteger(item.contextCompactHardTriggerTokens, `${label}.contextCompactHardTriggerTokens`) } : {}),
    ...(item.contextCompactMinNewMessages !== undefined ? { contextCompactMinNewMessages: optionalInteger(item.contextCompactMinNewMessages, `${label}.contextCompactMinNewMessages`) } : {}),
    ...(item.lcmSummaryBatchSize !== undefined ? { lcmSummaryBatchSize: optionalInteger(item.lcmSummaryBatchSize, `${label}.lcmSummaryBatchSize`) } : {}),
    ...(item.migrateLegacyState !== undefined ? { migrateLegacyState: optionalBoolean(item.migrateLegacyState, `${label}.migrateLegacyState`) } : {}),
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(item)) {
    if (!key.trim()) throw new Error(`${label} keys must be non-empty strings`)
    if (typeof raw !== "string") throw new Error(`${label}.${key} must be a string`)
    if (raw === "[redacted]") throw new Error(`${label}.${key} is redacted; supply the actual value`)
    result[key] = raw
  }
  return result
}

function parseMcpAuth(value: unknown, label: string): McpServerConfig["auth"] {
  if (value === undefined) return undefined
  const item = object(value, label)
  const type = optionalString(item.type, `${label}.type`)
  if (type === "bearer") {
    const unknown = Object.keys(item).filter((key) => !["type", "token"].includes(key))
    if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
    const token = optionalSensitiveString(item.token, `${label}.token`)
    if (!token) throw new Error(`${label}.token is required for bearer auth`)
    return { type, token }
  }
  if (type === "basic") {
    const unknown = Object.keys(item).filter((key) => !["type", "username", "password"].includes(key))
    if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
    const username = optionalString(item.username, `${label}.username`)
    const password = optionalSensitiveString(item.password, `${label}.password`)
    if (!username || !password) throw new Error(`${label}.username and ${label}.password are required for basic auth`)
    return { type, username, password }
  }
  throw new Error(`${label}.type must be bearer or basic`)
}

function parseMcp(value: unknown, label: string): Record<string, McpServerConfig> | undefined {
  if (value === undefined) return undefined
  const servers = object(value, label)
  const result: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${label}.${name} must use only letters, numbers, underscores, or hyphens`)
    const item = object(raw, `${label}.${name}`)
    const allowed = new Set(["url", "command", "args", "cwd", "env", "headers", "auth"])
    const unknown = Object.keys(item).filter((key) => !allowed.has(key))
    if (unknown.length > 0) throw new Error(`${label}.${name} has unknown keys: ${unknown.join(", ")}`)
    const url = optionalString(item.url, `${label}.${name}.url`)
    const command = optionalString(item.command, `${label}.${name}.command`)
    if (Boolean(url) === Boolean(command)) throw new Error(`${label}.${name} must set exactly one of url or command`)
    if (url) {
      const parsed = new URL(url)
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error(`${label}.${name}.url must be an HTTP(S) URL without embedded credentials`)
      }
      if (item.args !== undefined || item.cwd !== undefined || item.env !== undefined) {
        throw new Error(`${label}.${name} args, cwd, and env are only valid with command`)
      }
    }
    if (command && (item.headers !== undefined || item.auth !== undefined)) {
      throw new Error(`${label}.${name} headers and auth are only valid with url`)
    }
    if (item.auth !== undefined && item.headers !== undefined) {
      const headers = object(item.headers, `${label}.${name}.headers`)
      if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
        throw new Error(`${label}.${name} cannot set both auth and an Authorization header`)
      }
    }
    let args: string[] | undefined
    if (item.args !== undefined) {
      if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
        throw new Error(`${label}.${name}.args must be an array of strings`)
      }
      args = item.args as string[]
    }
    result[name] = {
      ...(url ? { url } : {}),
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(optionalString(item.cwd, `${label}.${name}.cwd`) ? { cwd: String(item.cwd).trim() } : {}),
      ...(item.env !== undefined ? { env: stringRecord(item.env, `${label}.${name}.env`) } : {}),
      ...(item.headers !== undefined ? { headers: stringRecord(item.headers, `${label}.${name}.headers`) } : {}),
      ...(item.auth !== undefined ? { auth: parseMcpAuth(item.auth, `${label}.${name}.auth`) } : {}),
    }
  }
  return result
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

function parseServer(value: unknown, label: string): ServerConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const unknown = Object.keys(item).filter((key) => key !== "iroh")
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const iroh = item.iroh
  if (iroh === undefined) return {}
  const irohItem = object(iroh, `${label}.iroh`)
  const irohUnknown = Object.keys(irohItem).filter((key) => !["ticket", "token"].includes(key))
  if (irohUnknown.length > 0) throw new Error(`${label}.iroh has unknown keys: ${irohUnknown.join(", ")}`)
  return {
    iroh: {
      ...(optionalString(irohItem.ticket, `${label}.iroh.ticket`) ? { ticket: String(irohItem.ticket).trim() } : {}),
      ...(optionalSensitiveString(irohItem.token, `${label}.iroh.token`) ? { token: optionalSensitiveString(irohItem.token, `${label}.iroh.token`)! } : {}),
    },
  }
}

export const DEFAULT_AGENT_EDIT_PATHS = ["model", "fallback", "summary", "runtime", "delegation", "discord"] as const
const IMMUTABLE_CONFIG_PATHS = ["id", "home", "client", "workspace", "server", "worker", "configPolicy", "embedding.dimensions"]

function validPolicyPath(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(path) && !path.split(".").some((part) => DANGEROUS_KEYS.has(part))
}

function parseConfigPolicy(value: unknown, label: string): ConfigPolicy {
  if (value === undefined) return { selfEdit: true, allowedPaths: [...DEFAULT_AGENT_EDIT_PATHS] }
  const item = object(value, label)
  const unknown = Object.keys(item).filter((key) => !["selfEdit", "allowedPaths", "enforcedPaths"].includes(key))
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const paths = (key: "allowedPaths" | "enforcedPaths"): string[] | undefined => {
    const raw = item[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.some((path) => typeof path !== "string" || !validPolicyPath(path))) throw new Error(`${label}.${key} must be an array of dot paths`)
    return [...new Set(raw)] as string[]
  }
  return {
    selfEdit: item.selfEdit === undefined ? true : optionalBoolean(item.selfEdit, `${label}.selfEdit`),
    allowedPaths: paths("allowedPaths") ?? [...DEFAULT_AGENT_EDIT_PATHS],
    ...(paths("enforcedPaths") ? { enforcedPaths: paths("enforcedPaths") } : {}),
  }
}

/** Returns true for structural and secret paths that policy must never delegate. */
export function isProtectedConfigPath(path: string): boolean {
  const parts = path.split(".")
  return IMMUTABLE_CONFIG_PATHS.some((locked) => path === locked || path.startsWith(`${locked}.`)) ||
    path === "secrets" || path.startsWith("secrets.") ||
    parts.some((part) => /^(?:apiKey|token|secret|password)$/i.test(part)) ||
    path.startsWith("mcp.") || path.startsWith("webhooks.") || path.startsWith("settings.")
}

export function isAllowedConfigPath(policy: ConfigPolicy | undefined, path: string): boolean {
  if (isProtectedConfigPath(path) || policy?.selfEdit === false) return false
  const allowed = policy?.allowedPaths ?? DEFAULT_AGENT_EDIT_PATHS
  // Endpoint changes can redirect credentials. A parent block never grants them implicitly.
  if (path.endsWith(".baseUrl")) return allowed.some((entry) => entry === path)
  return allowed.some((entry) => path === entry || path.startsWith(`${entry}.`))
}

function parseWorker(value: unknown, label: string): WorkerConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const unknown = Object.keys(item).filter((key) => key !== "mode")
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const mode = optionalString(item.mode, `${label}.mode`)
  if (mode !== undefined && mode !== "local" && mode !== "remote") {
    throw new Error(`${label}.mode must be local or remote`)
  }
  return mode === undefined ? {} : { mode }
}

/**
 * Parse and validate a single agent yaml file at `filePath` into a typed
 * {@link AgentFile}. Throws on malformed yaml, unknown top-level keys, or
 * invalid field shapes. The `client` requirement is enforced separately by the
 * control plane resolver because standalone workers reuse this parser.
 */
export function parseAgentConfig(raw: unknown, label = "agent config"): AgentConfig {
  const item = object(raw, label)
  const unknown = Object.keys(item).filter((key) => !AGENT_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${label}: unknown keys: ${unknown.join(", ")}`)
  if (item.port !== undefined && (typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535)) {
    throw new Error(`${label}: port must be an integer from 1 to 65535`)
  }
  if (item.id !== undefined && (!optionalString(item.id, `${label}.id`) || !/^[a-zA-Z0-9_-]+$/.test(String(item.id).trim()))) {
    throw new Error(`${label}.id must use only letters, numbers, underscores, or hyphens`)
  }

  const secrets = parseSecrets(item.secrets, `${label}.secrets`)

  const embedding = parseProvider(item.embedding, `${label}.embedding`, false, ["dimensions"]) as AgentFile["embedding"]
  if (item.embedding && "dimensions" in object(item.embedding, `${label}.embedding`)) {
    const dimensions = object(item.embedding, `${label}.embedding`).dimensions
    if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1) {
      throw new Error(`${label}.embedding.dimensions must be a positive integer`)
    }
    if (embedding) embedding.dimensions = dimensions
  }

  return {
    ...(optionalString(item.id, `${label}.id`) ? { id: String(item.id).trim() } : {}),
    ...(optionalString(item.name, `${label}.name`) ? { name: String(item.name).trim() } : {}),
    ...(typeof item.port === "number" ? { port: item.port } : {}),
    ...(optionalString(item.home, `${label}.home`) ? { home: String(item.home).trim() } : {}),
    ...(optionalString(item.client, `${label}.client`) ? { client: String(item.client).trim() } : {}),
    ...(optionalString(item.workspace, `${label}.workspace`) ? { workspace: String(item.workspace).trim() } : {}),
    ...(item.model !== undefined ? { model: parseProvider(item.model, `${label}.model`, true) } : {}),
    ...(item.fallback !== undefined ? { fallback: parseProvider(item.fallback, `${label}.fallback`, false) } : {}),
    ...(embedding ? { embedding } : {}),
    ...(item.summary !== undefined ? { summary: parseProvider(item.summary, `${label}.summary`, false) } : {}),
    ...(item.discord !== undefined ? { discord: parseDiscord(item.discord, `${label}.discord`) } : {}),
    ...(item.delegation !== undefined ? { delegation: parseDelegation(item.delegation, `${label}.delegation`) } : {}),
    ...(item.webhooks !== undefined ? { webhooks: parseWebhooks(item.webhooks, `${label}.webhooks`, secrets) } : {}),
    ...(item.runtime !== undefined ? { runtime: parseRuntime(item.runtime, `${label}.runtime`) } : {}),
    ...(item.mcp !== undefined ? { mcp: parseMcp(item.mcp, `${label}.mcp`) } : {}),
    ...(item.server !== undefined ? { server: parseServer(item.server, `${label}.server`) } : {}),
    ...(item.worker !== undefined ? { worker: parseWorker(item.worker, `${label}.worker`) } : {}),
    ...(item.settings !== undefined ? { settings: parseSettings(item.settings, `${label}.settings`) } : {}),
    ...(secrets ? { secrets } : {}),
    configPolicy: parseConfigPolicy(item.configPolicy, `${label}.configPolicy`),
  }
}

/** Parse YAML then validate it through the YAML-independent parser. */
export function parseAgentFile(filePath: string): AgentFile {
  let raw: unknown
  try { raw = parseYaml(fs.readFileSync(filePath, "utf8")) }
  catch (error) { throw new Error(`${filePath}: invalid yaml: ${error instanceof Error ? error.message : String(error)}`) }
  return parseAgentConfig(raw, filePath)
}

function parseSecrets(value: unknown, label: string): AgentSecrets | undefined {
  if (value === undefined) return undefined
  const item = object(value, label); const result: AgentSecrets = {}
  for (const [target, ref] of Object.entries(item)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(target) || !/^(?:model|fallback|embedding|summary|discord|webhooks\.[a-zA-Z0-9_-]+|server\.iroh)\.(?:apiKey|token|secret)$/.test(target)) throw new Error(`${label}.${target} is not a supported secret target`)
    const parsed = optionalSecret(ref, `${label}.${target}`)
    if (!parsed || typeof parsed === "string") throw new Error(`${label}.${target} must be { env: string } or { file: string }`)
    result[target] = parsed
  }
  return result
}

const REDACTED = "[redacted]"
/** A transport-safe config view; opaque secret refs are also hidden. */
export function redactAgentConfig<T>(value: T): T {
  const visit = (raw: unknown, key = ""): unknown => {
    if (Array.isArray(raw)) return raw.map((item) => visit(item))
    if (!raw || typeof raw !== "object") return /^(?:apiKey|token|secret|password|authorization)$/i.test(key) ? REDACTED : raw
    if ("env" in (raw as object) || "file" in (raw as object)) return REDACTED
    const result: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(raw as Record<string, unknown>)) {
      result[childKey] = /^(?:apiKey|token|secret|password|authorization)$/i.test(childKey) || childKey === "secrets" || childKey === "settings" || key === "env" || key === "headers"
        ? REDACTED : visit(child, childKey)
    }
    return result
  }
  return visit(value) as T
}

/**
 * Defaults used only when an operator creates a new agent through the API.
 * Nothing here assumes a model or credential: interactive creation prompts for
 * those, and a non-interactive draft stays modelless until configured.
 */
export const DEFAULT_NEW_AGENT_CONFIG: Omit<AgentConfig, "id"> = {
  client: "local",
  discord: { enabled: false },
  delegation: { enabled: true, maxConcurrent: 2, profiles: [] },
  runtime: {
    imageMaxBytes: 1_000_000, primaryToolChoice: "auto", fallbackToolChoice: "auto", fallbackEnforceContextLimit: true,
    contextCompactTriggerTokens: 100_000, contextCompactHardTriggerTokens: 120_000, contextCompactMinNewMessages: 4,
    lcmSummaryBatchSize: 4, migrateLegacyState: false,
  },
  configPolicy: { selfEdit: true, allowedPaths: [...DEFAULT_AGENT_EDIT_PATHS] },
}

function providerSettings(prefix: string, config: OpenAiProviderConfig | undefined): Record<string, string> {
  if (!config) return {}
  return {
    ...(config.name ? { [`${prefix}MODEL`]: config.name } : {}),
    ...(config.baseUrl ? { [`${prefix}BASE_URL`]: config.baseUrl } : {}),
    ...(resolveSecret(config.apiKey) ? { [`${prefix}API_KEY`]: resolveSecret(config.apiKey)! } : {}),
  }
}

/** Resolve only declared secret fields. Missing references stay absent so drafts can boot safely. */
export function resolveAgentSecrets(config: AgentFile, environment: NodeJS.ProcessEnv = process.env): AgentFile {
  const resolved = structuredClone(config) as AgentFile
  const set = (target: string, value: string): void => {
    const parts = target.split("."); let cursor: Record<string, unknown> = resolved as Record<string, unknown>
    for (const part of parts.slice(0, -1)) { if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {}; cursor = cursor[part] as Record<string, unknown> }
    const leaf = parts.at(-1)!
    // An operator-provided inline value is more explicit than a default reference.
    if (cursor[leaf] === undefined) cursor[leaf] = value
  }
  for (const [target, ref] of Object.entries(config.secrets ?? {})) {
    const value = resolveSecret(ref, environment)
    if (value) set(target, value)
  }
  delete resolved.secrets
  return resolved
}

/**
 * Flatten a parsed {@link AgentFile} into the runtime `KEY=value` environment
 * variables consumed by an agent worker. The same mapping runs on the server
 * (for supervised workers) and on standalone remote workers.
 */
export function agentSettings(config: AgentFile): Record<string, string> {
  // This is the sole flattening boundary for both managed and standalone workers.
  config = resolveAgentSecrets(config)
  const settings: Record<string, string> = {}
  const model = config.model
  if (model?.provider === "anthropic") {
    settings.USE_ANTHROPIC = "true"
    if (model.name) settings.ANTHROPIC_MODEL = model.name
    if (model.baseUrl) settings.ANTHROPIC_BASE_URL = model.baseUrl
    if (resolveSecret(model.apiKey)) settings.ANTHROPIC_API_KEY = resolveSecret(model.apiKey)!
  } else if (model) {
    settings.USE_ANTHROPIC = "false"
    if (model.name) settings.MODEL = model.name
    if (model.baseUrl) settings.OPENAI_BASE_URL = model.baseUrl
    if (resolveSecret(model.apiKey)) settings.OPENAI_API_KEY = resolveSecret(model.apiKey)!
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
  if (resolveSecret(config.discord?.token)) settings.DISCORD_BOT_TOKEN = resolveSecret(config.discord?.token)!
  if (config.discord?.enabled !== undefined) settings.DISCORD_GATEWAY_ENABLED = String(config.discord.enabled)
  if (config.discord?.botUserId) settings.DISCORD_BOT_USER_ID = config.discord.botUserId
  if (config.discord?.dmWhitelist) settings.DISCORD_DM_WHITELIST = config.discord.dmWhitelist
  if (config.discord?.postures) settings.DISCORD_POSTURES = JSON.stringify(config.discord.postures)
  if (config.discord?.posture_bypass) settings.DISCORD_POSTURE_BYPASS = JSON.stringify(config.discord.posture_bypass)
  if (config.discord?.scanChannelIds) settings.DISCORD_SCAN_CHANNEL_IDS = config.discord.scanChannelIds
  if (config.discord?.wakeOnEvent !== undefined) settings.DISCORD_WAKE_ON_EVENT = String(config.discord.wakeOnEvent)
  const discord = config.discord
  if (discord?.gatewayTrace !== undefined) settings.DISCORD_GATEWAY_TRACE = String(discord.gatewayTrace)
  if (discord?.gatewayRawFallback !== undefined) settings.DISCORD_GATEWAY_RAW_FALLBACK = String(discord.gatewayRawFallback)
  if (discord?.batchIntervalMs !== undefined) settings.DISCORD_BATCH_INTERVAL_MS = String(discord.batchIntervalMs)
  if (discord?.batchOnlyConfigured !== undefined) settings.DISCORD_BATCH_ONLY_CONFIGURED = String(discord.batchOnlyConfigured)
  if (discord?.pendingAutoSeenMinutes !== undefined) settings.DISCORD_PENDING_AUTO_SEEN_MINUTES = String(discord.pendingAutoSeenMinutes)
  if (discord?.batchScan !== undefined) settings.DISCORD_BATCH_SCAN = String(discord.batchScan)
  if (discord?.batchMaxMessages !== undefined) settings.DISCORD_BATCH_MAX_MESSAGES = String(discord.batchMaxMessages)
  if (discord?.cooldownChannels) settings.COOLDOWN_CHANNELS = discord.cooldownChannels
  if (discord?.cooldownTz) settings.COOLDOWN_TZ = discord.cooldownTz
  if (discord?.gastownForumChannelId) settings.DISCORD_GASTOWN_FORUM_CHANNEL_ID = discord.gastownForumChannelId
  const runtime = config.runtime
  if (runtime?.imageMaxBytes !== undefined) settings.IMAGE_TOOL_MAX_BYTES = String(runtime.imageMaxBytes)
  if (runtime?.primaryToolChoice) settings.PRIMARY_TOOL_CHOICE = runtime.primaryToolChoice
  if (runtime?.fallbackToolChoice) settings.FALLBACK_TOOL_CHOICE = runtime.fallbackToolChoice
  if (runtime?.fallbackEnforceContextLimit !== undefined) settings.FALLBACK_ENFORCE_CONTEXT_LIMIT = String(runtime.fallbackEnforceContextLimit)
  if (runtime?.contextCompactTriggerTokens !== undefined) settings.CONTEXT_COMPACT_TRIGGER_TOKENS = String(runtime.contextCompactTriggerTokens)
  if (runtime?.contextCompactHardTriggerTokens !== undefined) settings.CONTEXT_COMPACT_HARD_TRIGGER_TOKENS = String(runtime.contextCompactHardTriggerTokens)
  if (runtime?.contextCompactMinNewMessages !== undefined) settings.CONTEXT_COMPACT_MIN_NEW_MESSAGES = String(runtime.contextCompactMinNewMessages)
  if (runtime?.lcmSummaryBatchSize !== undefined) settings.LCM_SUMMARY_BATCH_SIZE = String(runtime.lcmSummaryBatchSize)
  if (runtime?.migrateLegacyState !== undefined) settings.NIRI_MIGRATE_LEGACY_STATE = String(runtime.migrateLegacyState)
  if (config.delegation) settings.NIRI_DELEGATION_CONFIG = JSON.stringify(config.delegation)
  if (config.mcp && Object.keys(config.mcp).length > 0) settings.NIRI_MCP_CONFIG = JSON.stringify(config.mcp)
  if (config.server?.iroh?.ticket) settings.NIRI_SERVER_IROH_TICKET = config.server.iroh.ticket
  if (resolveSecret(config.server?.iroh?.token)) settings.NIRI_SERVER_IROH_TOKEN = resolveSecret(config.server?.iroh?.token)!
  for (const [key, value] of Object.entries(config.settings ?? {})) settings[key] = String(value)
  return settings
}
