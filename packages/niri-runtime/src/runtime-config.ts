import { AGENT_ID } from "./agent-config"
import { ServiceError, type ServiceArgs } from "./server-native-services"

const CONFIG_SERVER_TIMEOUT_MS = 30_000

type ConfigFetch = typeof fetch
type ConfigRuntimeOptions = {
  agentId?: string
  environment?: NodeJS.ProcessEnv
  fetch?: ConfigFetch
}

type ConfigMethod = "config" | "history" | "status" | "webhooks"

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ServiceError("invalid_argument", `${name} is required`)
  return value.trim()
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceError("invalid_argument", `${name} must be an object`)
  return value as Record<string, unknown>
}

function noArguments(args: ServiceArgs): void {
  if (Object.keys(args).length) throw new ServiceError("invalid_argument", "this config operation takes no arguments")
}

function configBase(environment: NodeJS.ProcessEnv): URL {
  const raw = environment.NIRI_CONFIG_SERVER_URL?.trim()
  if (!raw) throw new ServiceError("unavailable", "runtime configuration service is not configured")
  let url: URL
  try { url = new URL(raw) } catch { throw new ServiceError("unavailable", "runtime configuration server URL is invalid") }
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "::1" && host !== "[::1]")) {
    throw new ServiceError("unavailable", "runtime configuration server must use a loopback HTTP URL")
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "" ) || url.search || url.hash) {
    throw new ServiceError("unavailable", "runtime configuration server URL must be an origin")
  }
  return url
}

function configToken(environment: NodeJS.ProcessEnv): string {
  const token = environment.NIRI_CONFIG_TOKEN?.trim()
  if (!token) throw new ServiceError("unavailable", "runtime configuration service is not configured")
  return token
}

function endpoint(base: URL, agentId: string, method: ConfigMethod): URL {
  const suffix = method === "config" ? "config" : `config/${method}`
  return new URL(`/agents/${encodeURIComponent(agentId)}/${suffix}`, base)
}

function statusCode(status: number): ServiceError["code"] {
  if (status === 400 || status === 422) return "invalid_argument"
  if (status === 401 || status === 403) return "unauthorized"
  if (status === 404) return "not_found"
  if (status === 409 || status === 412) return "conflict"
  if (status === 408 || status === 429 || status >= 500) return "unavailable"
  return "operation_failed"
}

async function responseBody(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return raw }
}

function responseMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>
    const error = body.error
    if (typeof error === "string" && error.trim()) return error
    if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return (error as Record<string, unknown>).message as string
    if (typeof body.message === "string" && body.message.trim()) return body.message
  }
  return fallback
}

export function configRevision(environment: NodeJS.ProcessEnv = process.env): string | null {
  return environment.NIRI_CONFIG_REVISION?.trim() || null
}

/** The only config authority is the control server. The runtime never writes a local config copy. */
export class RuntimeConfigService {
  private readonly agentId: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly request: ConfigFetch

  constructor(options: ConfigRuntimeOptions = {}) {
    this.agentId = options.agentId?.trim() || AGENT_ID
    this.environment = options.environment ?? process.env
    this.request = options.fetch ?? fetch
  }

  async get(args: ServiceArgs): Promise<unknown> {
    noArguments(args)
    return this.forward("GET", "config")
  }

  async history(args: ServiceArgs): Promise<unknown> {
    noArguments(args)
    return this.forward("GET", "history")
  }

  async status(args: ServiceArgs): Promise<unknown> {
    noArguments(args)
    return this.forward("GET", "status")
  }

  async update(args: ServiceArgs): Promise<unknown> {
    const patch = object(args.patch, "patch")
    const expectedRevision = args.expected_revision
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
      throw new ServiceError("invalid_argument", "expected_revision must be a positive integer")
    }
    const reason = args.reason === undefined ? undefined : text(args.reason, "reason")
    const requestId = text(args.request_id, "request_id")
    if (Object.keys(args).some((key) => !["patch", "expected_revision", "reason", "request_id"].includes(key))) {
      throw new ServiceError("invalid_argument", "unknown config update argument")
    }
    const receipt = await this.forward("PATCH", "config", {
      patch,
      expectedRevision,
      ...(reason ? { reason } : {}),
      requestId,
    })
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new ServiceError("unavailable", "runtime configuration service returned an invalid update receipt")
    }
    return { ...(receipt as Record<string, unknown>), requestId }
  }

  async createWebhook(args: ServiceArgs): Promise<unknown> {
    if (Object.keys(args).some((key) => !["name", "expected_revision", "signature_header", "signature_prefix", "reason", "request_id"].includes(key))) {
      throw new ServiceError("invalid_argument", "unknown webhook creation argument")
    }
    const name = text(args.name, "name")
    const expectedRevision = args.expected_revision
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
      throw new ServiceError("invalid_argument", "expected_revision must be a positive integer")
    }
    const requestId = text(args.request_id, "request_id")
    const signatureHeader = args.signature_header === undefined ? undefined : text(args.signature_header, "signature_header")
    if (args.signature_prefix !== undefined && typeof args.signature_prefix !== "string") {
      throw new ServiceError("invalid_argument", "signature_prefix must be a string")
    }
    const reason = args.reason === undefined ? undefined : text(args.reason, "reason")
    const receipt = await this.forward("POST", "webhooks", {
      name,
      expectedRevision,
      ...(signatureHeader ? { signatureHeader } : {}),
      ...(typeof args.signature_prefix === "string" ? { signaturePrefix: args.signature_prefix } : {}),
      ...(reason ? { reason } : {}),
      requestId,
    })
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new ServiceError("unavailable", "runtime configuration service returned an invalid webhook receipt")
    }
    const result = receipt as Record<string, unknown>
    if (typeof result.path !== "string" || !result.path.startsWith(`/agents/${encodeURIComponent(this.agentId)}/trigger/webhook/`)) {
      throw new ServiceError("unavailable", "runtime configuration service returned an invalid webhook path")
    }
    return { ...result, url: new URL(result.path, configBase(this.environment)).toString(), requestId }
  }

  private async forward(method: "GET" | "PATCH" | "POST", target: ConfigMethod, body?: Record<string, unknown>): Promise<unknown> {
    const base = configBase(this.environment)
    const token = configToken(this.environment)
    let response: Response
    try {
      response = await this.request(endpoint(base, this.agentId, target), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(CONFIG_SERVER_TIMEOUT_MS),
      })
    } catch (error) {
      throw new ServiceError("unavailable", `runtime configuration service is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const payload = await responseBody(response)
    if (!response.ok) throw new ServiceError(statusCode(response.status), responseMessage(payload, `runtime configuration service returned HTTP ${response.status}`))
    return payload
  }
}

export const runtimeConfig = new RuntimeConfigService()
