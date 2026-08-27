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
export type ProviderConfig = {
  provider?: "openai" | "anthropic"
  name?: string
  baseUrl?: string
  apiKey?: string
  thinking?: boolean
}

/** Provider shape without the discriminator fields used by auxiliary providers. */
export type OpenAiProviderConfig = Omit<ProviderConfig, "provider" | "thinking">

/** First-party `discord:` block. */
export type DiscordConfig = {
  token?: string
  enabled?: boolean
  botUserId?: string
  dmWhitelist?: string
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
  antigravity?: { enabled?: boolean; port?: number; binaryPath?: string }
  codex?: { enabled?: boolean; port?: number; model?: string; reasoningEffort?: string }
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
}

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
    ...(optionalString(item.apiKey, `${label}.apiKey`) ? { apiKey: String(item.apiKey).trim() } : {}),
    ...(allowProvider && item.thinking !== undefined ? { thinking: optionalBoolean(item.thinking, `${label}.thinking`) } : {}),
  }
}

function parseDiscord(value: unknown, label: string): DiscordConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["token", "enabled", "botUserId", "dmWhitelist", "posture_bypass", "scanChannelIds", "wakeOnEvent", "gatewayTrace", "gatewayRawFallback", "batchIntervalMs", "batchOnlyConfigured", "pendingAutoSeenMinutes", "batchScan", "batchMaxMessages", "cooldownChannels", "cooldownTz", "gastownForumChannelId"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const postureBypass = item.posture_bypass === undefined ? undefined : object(item.posture_bypass, `${label}.posture_bypass`)
  if (postureBypass) {
    const postureUnknown = Object.keys(postureBypass).filter((key) => !["users", "channels"].includes(key))
    if (postureUnknown.length > 0) throw new Error(`${label}.posture_bypass has unknown keys: ${postureUnknown.join(", ")}`)
  }
  const postureUsers = postureBypass ? optionalSnowflakeList(postureBypass.users, `${label}.posture_bypass.users`) : undefined
  const postureChannels = postureBypass ? optionalSnowflakeList(postureBypass.channels, `${label}.posture_bypass.channels`) : undefined
  return {
    ...(optionalString(item.token, `${label}.token`) ? { token: String(item.token).trim() } : {}),
    ...(item.enabled !== undefined ? { enabled: optionalBoolean(item.enabled, `${label}.enabled`) } : {}),
    ...(optionalString(item.botUserId, `${label}.botUserId`) ? { botUserId: String(item.botUserId).trim() } : {}),
    ...(optionalString(item.dmWhitelist, `${label}.dmWhitelist`) ? { dmWhitelist: String(item.dmWhitelist).trim() } : {}),
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

function parseWebhooks(value: unknown, label: string): Record<string, WebhookConfig> | undefined {
  if (value === undefined) return undefined
  const entries = object(value, label)
  const result: Record<string, WebhookConfig> = {}
  for (const [name, raw] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${label}.${name} has an invalid webhook name`)
    const item = object(raw, `${label}.${name}`)
    const unknown = Object.keys(item).filter((key) => !["secret", "signatureHeader", "signaturePrefix"].includes(key))
    if (unknown.length > 0) throw new Error(`${label}.${name} has unknown keys: ${unknown.join(", ")}`)
    const secret = optionalString(item.secret, `${label}.${name}.secret`)
    if (!secret) throw new Error(`${label}.${name}.secret is required`)
    const signatureHeader = optionalString(item.signatureHeader, `${label}.${name}.signatureHeader`)
    if (signatureHeader && !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(signatureHeader)) {
      throw new Error(`${label}.${name}.signatureHeader must be an HTTP header name`)
    }
    if (item.signaturePrefix !== undefined && typeof item.signaturePrefix !== "string") {
      throw new Error(`${label}.${name}.signaturePrefix must be a string`)
    }
    result[name] = {
      secret,
      ...(signatureHeader ? { signatureHeader: signatureHeader.toLowerCase() } : {}),
      ...(typeof item.signaturePrefix === "string" ? { signaturePrefix: item.signaturePrefix } : {}),
    }
  }
  return result
}

function parseRuntime(value: unknown, label: string): RuntimeConfig | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const allowed = new Set(["imageMaxBytes", "primaryToolChoice", "fallbackToolChoice", "fallbackEnforceContextLimit", "contextCompactTriggerTokens", "contextCompactHardTriggerTokens", "contextCompactMinNewMessages", "lcmSummaryBatchSize", "migrateLegacyState", "antigravity", "codex"])
  const unknown = Object.keys(item).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  const parseBridge = (raw: unknown, bridgeLabel: string, extra: string[]): Record<string, unknown> | undefined => {
    if (raw === undefined) return undefined
    const bridge = object(raw, bridgeLabel)
    const bridgeUnknown = Object.keys(bridge).filter((key) => !["enabled", "port", ...extra].includes(key))
    if (bridgeUnknown.length) throw new Error(`${bridgeLabel} has unknown keys: ${bridgeUnknown.join(", ")}`)
    return bridge
  }
  const antigravity = parseBridge(item.antigravity, `${label}.antigravity`, ["binaryPath"])
  const codex = parseBridge(item.codex, `${label}.codex`, ["model", "reasoningEffort"])
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
    ...(antigravity ? { antigravity: { ...(antigravity.enabled !== undefined ? { enabled: optionalBoolean(antigravity.enabled, `${label}.antigravity.enabled`) } : {}), ...(antigravity.port !== undefined ? { port: optionalInteger(antigravity.port, `${label}.antigravity.port`) } : {}), ...(antigravity.binaryPath !== undefined ? { binaryPath: optionalString(antigravity.binaryPath, `${label}.antigravity.binaryPath`) } : {}) } } : {}),
    ...(codex ? { codex: { ...(codex.enabled !== undefined ? { enabled: optionalBoolean(codex.enabled, `${label}.codex.enabled`) } : {}), ...(codex.port !== undefined ? { port: optionalInteger(codex.port, `${label}.codex.port`) } : {}), ...(codex.model !== undefined ? { model: optionalString(codex.model, `${label}.codex.model`) } : {}), ...(codex.reasoningEffort !== undefined ? { reasoningEffort: optionalString(codex.reasoningEffort, `${label}.codex.reasoningEffort`) } : {}) } } : {}),
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(item)) {
    if (!key.trim()) throw new Error(`${label} keys must be non-empty strings`)
    if (typeof raw !== "string") throw new Error(`${label}.${key} must be a string`)
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
    const token = optionalString(item.token, `${label}.token`)
    if (!token) throw new Error(`${label}.token is required for bearer auth`)
    return { type, token }
  }
  if (type === "basic") {
    const unknown = Object.keys(item).filter((key) => !["type", "username", "password"].includes(key))
    if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
    const username = optionalString(item.username, `${label}.username`)
    const password = optionalString(item.password, `${label}.password`)
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
      ...(optionalString(irohItem.token, `${label}.iroh.token`) ? { token: String(irohItem.token).trim() } : {}),
    },
  }
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
    ...(item.delegation !== undefined ? { delegation: parseDelegation(item.delegation, `${filePath}.delegation`) } : {}),
    ...(item.webhooks !== undefined ? { webhooks: parseWebhooks(item.webhooks, `${filePath}.webhooks`) } : {}),
    ...(item.runtime !== undefined ? { runtime: parseRuntime(item.runtime, `${filePath}.runtime`) } : {}),
    ...(item.mcp !== undefined ? { mcp: parseMcp(item.mcp, `${filePath}.mcp`) } : {}),
    ...(item.server !== undefined ? { server: parseServer(item.server, `${filePath}.server`) } : {}),
    ...(item.worker !== undefined ? { worker: parseWorker(item.worker, `${filePath}.worker`) } : {}),
    ...(item.settings !== undefined ? { settings: parseSettings(item.settings, `${filePath}.settings`) } : {}),
  }
}

function providerSettings(prefix: string, config: OpenAiProviderConfig | undefined): Record<string, string> {
  if (!config) return {}
  return {
    ...(config.name ? { [`${prefix}MODEL`]: config.name } : {}),
    ...(config.baseUrl ? { [`${prefix}BASE_URL`]: config.baseUrl } : {}),
    ...(config.apiKey ? { [`${prefix}API_KEY`]: config.apiKey } : {}),
  }
}

/**
 * Flatten a parsed {@link AgentFile} into the runtime `KEY=value` environment
 * variables consumed by an agent worker. The same mapping runs on the server
 * (for supervised workers) and on standalone remote workers.
 */
export function agentSettings(config: AgentFile): Record<string, string> {
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
  if (runtime?.antigravity?.enabled !== undefined) settings.ANTIGRAVITY_BRIDGE_ENABLED = String(runtime.antigravity.enabled)
  if (runtime?.antigravity?.port !== undefined) settings.ANTIGRAVITY_BRIDGE_PORT = String(runtime.antigravity.port)
  if (runtime?.antigravity?.binaryPath) settings.ANTIGRAVITY_BINARY_PATH = runtime.antigravity.binaryPath
  if (runtime?.codex?.enabled !== undefined) settings.CODEX_BRIDGE_ENABLED = String(runtime.codex.enabled)
  if (runtime?.codex?.port !== undefined) settings.CODEX_BRIDGE_PORT = String(runtime.codex.port)
  if (runtime?.codex?.model) settings.CODEX_BRIDGE_MODEL = runtime.codex.model
  if (runtime?.codex?.reasoningEffort) settings.CODEX_BRIDGE_REASONING_EFFORT = runtime.codex.reasoningEffort
  if (config.delegation) settings.NIRI_DELEGATION_CONFIG = JSON.stringify(config.delegation)
  if (config.mcp && Object.keys(config.mcp).length > 0) settings.NIRI_MCP_CONFIG = JSON.stringify(config.mcp)
  if (config.server?.iroh?.ticket) settings.NIRI_SERVER_IROH_TICKET = config.server.iroh.ticket
  if (config.server?.iroh?.token) settings.NIRI_SERVER_IROH_TOKEN = config.server.iroh.token
  for (const [key, value] of Object.entries(config.settings ?? {})) settings[key] = String(value)
  return settings
}
