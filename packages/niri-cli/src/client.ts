import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type AgentConfig = Record<string, Json>
export type Application = { state?: string; error?: string; desiredRevision?: number | string; activeRevision?: number | string; [key: string]: Json | undefined } | undefined

export type AgentSummary = {
  id: string
  name?: string
  status?: string
  config?: AgentConfig
  model?: Json
  revision?: number | string
  activeRevision?: number | string
  application?: Application
}

export type ConfigSnapshot = {
  id: string
  revision?: number | string
  activeRevision?: number | string
  application?: Application
  config: AgentConfig
}

export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal }

const trimUrl = (url: string) => url.replace(/\/+$/, "")
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export const isLocalServer = (baseUrl: string): boolean => {
  try { const url = new URL(baseUrl); return !url.username && !url.password && localHosts.has(url.hostname) } catch { return false }
}

export async function localOperatorToken(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!isLocalServer(baseUrl)) return undefined
  const controlHome = env.NIRI_CONTROL_HOME?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data", "control")
  try {
    const token = (await fs.readFile(path.join(controlHome, "admin.token"), "utf8")).trim()
    return token || undefined
  } catch { return undefined }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "HttpError" }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown; message?: unknown }
    if (typeof body.error === "string") return body.error
    if (typeof body.message === "string") return body.message
  } catch {}
  return `${response.status} ${response.statusText}`.trim() || "request failed"
}

export class NiriClient {
  readonly baseUrl: string
  readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor({ baseUrl = process.env.NIRI_SERVER_URL ?? "http://127.0.0.1:3000", token, fetchImpl = fetch }: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch } = {}) {
    const url = new URL(baseUrl)
    if (url.username || url.password) throw new Error("server URL must not contain credentials")
    this.baseUrl = trimUrl(url.toString())
    this.token = token?.trim() || undefined
    this.fetchImpl = fetchImpl
  }

  async request<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method ?? "GET", headers, redirect: "error",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal,
    })
    if (!response.ok) throw new HttpError(response.status, await errorMessage(response))
    return await response.json() as T
  }

  list = async (signal?: AbortSignal): Promise<AgentSummary[]> => {
    const response = await this.request<{ agents?: unknown }>("/agents", { signal })
    if (!Array.isArray(response.agents)) throw new Error("invalid /agents response")
    return response.agents.filter((value): value is AgentSummary => Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string")
  }

  getConfig = (id: string): Promise<ConfigSnapshot> => this.request(`/agents/${encodeURIComponent(id)}/config`)
  create = (id: string, config?: AgentConfig, start = false, seed = false): Promise<ConfigSnapshot> => this.request("/agents", { method: "POST", body: { id, ...(config ? { config } : {}), start, ...(seed ? { seed: true } : {}) } })
  lifecycle = (id: string, action: "start" | "stop" | "restart"): Promise<unknown> => this.request(`/agents/${encodeURIComponent(id)}/${action}`, { method: "POST" })

  /** Config writes always obtain a fresh server revision before they mutate. */
  async patch(id: string, patch: AgentConfig, reason?: string): Promise<ConfigSnapshot> {
    const current = await this.getConfig(id)
    return this.request(`/agents/${encodeURIComponent(id)}/config`, { method: "PATCH", body: { patch, expectedRevision: current.revision, ...(reason ? { reason } : {}), requestId: crypto.randomUUID() } })
  }

  async seed(id: string, config: AgentConfig, reason?: string): Promise<ConfigSnapshot> {
    const current = await this.getConfig(id)
    return this.request(`/agents/${encodeURIComponent(id)}/config/seed`, { method: "POST", body: { config, expectedRevision: current.revision, ...(reason ? { reason } : {}), requestId: crypto.randomUUID() } })
  }

  async diff(id: string, config: AgentConfig): Promise<unknown> {
    const current = await this.getConfig(id)
    return this.request(`/agents/${encodeURIComponent(id)}/config/diff`, { method: "POST", body: { config, expectedRevision: current.revision, requestId: crypto.randomUUID() } })
  }

  history = (id: string): Promise<{ history: unknown[] }> => this.request(`/agents/${encodeURIComponent(id)}/config/history`)
  async rollback(id: string, revision: number | string, reason?: string): Promise<ConfigSnapshot> {
    const current = await this.getConfig(id)
    return this.request(`/agents/${encodeURIComponent(id)}/config/rollback`, { method: "POST", body: { revision, expectedRevision: current.revision, ...(reason ? { reason } : {}), requestId: crypto.randomUUID() } })
  }
}
