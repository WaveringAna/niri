import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ClientToolHost } from "@mira/harness-core"
import {
  HARNESS_PROTOCOL_VERSION,
  parseClientLease,
  parseClientPollResponse,
  parseClientToolResult,
  type ClientHello,
  type ClientLease,
  type ClientToolResult,
  type ToolInvocation,
} from "@mira/harness-protocol"

export type RemoteToolClientOptions = {
  endpoint: string
  agentId: string
  clientId: string
  token: string
  host: ClientToolHost
  pollTimeoutMs?: number
  reconnectDelayMs?: number
  requestTimeoutMs?: number
  journalPath?: string
  fetchImpl?: typeof fetch
  onStatus?: (status: string) => void
}

type InvocationJournalEntry = ClientToolResult | { status: "in_flight"; startedAt: string }
type InvocationJournal = Record<string, InvocationJournalEntry>

function normalizedEndpoint(value: string): string {
  return value.replace(/\/+$/, "")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function responseError(data: unknown, res: Response): Error {
  const item = asRecord(data)
  const message = item && typeof item.error === "string" ? item.error : `${res.status} ${res.statusText}`
  return new Error(message)
}

function cancelledResult(invocation: ToolInvocation, output: string): ClientToolResult {
  return {
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: invocation.agentId,
    clientId: invocation.clientId,
    leaseId: invocation.leaseId,
    status: "cancelled",
    output,
    completedAt: new Date().toISOString(),
  }
}

export class RemoteToolClient {
  private readonly endpoint: string
  private readonly agentId: string
  private readonly clientId: string
  private readonly token: string
  private readonly host: ClientToolHost
  private readonly pollTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly journalPath: string | null
  private readonly fetchImpl: typeof fetch
  private readonly onStatus: ((status: string) => void) | undefined
  private readonly completed = new Map<string, ClientToolResult>()
  private readonly uncertain = new Set<string>()
  private stopped = false
  private activeAbort: AbortController | null = null
  private lease: ClientLease | null = null

  constructor(options: RemoteToolClientOptions) {
    this.endpoint = normalizedEndpoint(options.endpoint)
    this.agentId = options.agentId
    this.clientId = options.clientId
    this.token = options.token
    this.host = options.host
    this.pollTimeoutMs = Math.max(1_000, Math.min(30_000, options.pollTimeoutMs ?? 25_000))
    this.reconnectDelayMs = Math.max(100, options.reconnectDelayMs ?? 1_000)
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 15_000)
    this.journalPath = options.journalPath ? path.resolve(options.journalPath) : null
    this.fetchImpl = options.fetchImpl ?? fetch
    this.onStatus = options.onStatus
  }

  async start(): Promise<void> {
    if (!this.token.trim()) throw new Error("a tool client token is required")
    this.stopped = false
    await this.loadJournal()
    await this.host.start()

    while (!this.stopped) {
      try {
        this.lease = await this.hello()
        this.onStatus?.(`attached to ${this.agentId} as ${this.clientId}`)
        await this.flushCompleted(this.lease)
        await this.pollLoop(this.lease)
      } catch (error) {
        this.lease = null
        if (!this.stopped) {
          this.onStatus?.(`connection error: ${error instanceof Error ? error.message : String(error)}; retrying`)
          await delay(this.reconnectDelayMs)
        }
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.activeAbort?.abort()
    this.activeAbort = null
  }

  async close(): Promise<void> {
    const lease = this.lease
    this.stop()
    if (lease) {
      try {
        await this.request("/detach", { clientId: this.clientId, leaseId: lease.leaseId })
      } catch {
        this.onStatus?.("server detach was not acknowledged")
      }
    }
    this.lease = null
    await this.host.stop()
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    }
  }

  private async request(
    pathname: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error(`request timed out: ${pathname}`)), options.timeoutMs ?? this.requestTimeoutMs)
    timeout.unref?.()
    try {
      const res = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await parseResponse(res)
      if (!res.ok) throw responseError(data, res)
      return data
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  private async hello(): Promise<ClientLease> {
    const hello: ClientHello = {
      protocol: HARNESS_PROTOCOL_VERSION,
      agentId: this.agentId,
      clientId: this.clientId,
      capabilities: this.host.getCapabilities(),
      workspace: this.host.getWorkspace(),
    }
    const lease = parseClientLease(await this.request("/hello", hello))
    if (!lease) throw new Error("server returned an invalid client lease")
    if (lease.agentId !== this.agentId || lease.clientId !== this.clientId) {
      throw new Error("server returned a lease for a different agent or client")
    }
    return lease
  }

  private async pollLoop(lease: ClientLease): Promise<void> {
    while (!this.stopped) {
      this.activeAbort = new AbortController()
      let raw: unknown
      try {
        raw = await this.request(
          "/poll",
          { clientId: this.clientId, leaseId: lease.leaseId, timeoutMs: this.pollTimeoutMs },
          { signal: this.activeAbort.signal, timeoutMs: this.pollTimeoutMs + 5_000 },
        )
      } finally {
        this.activeAbort = null
      }
      if (this.stopped) return

      const response = parseClientPollResponse(raw)
      if (!response) throw new Error("server returned an invalid poll response")
      if (response.type === "keepalive") continue
      if (response.agentId !== this.agentId || response.clientId !== this.clientId || response.leaseId !== lease.leaseId) {
        throw new Error("server returned a tool call outside the active client lease")
      }

      const cached = this.completed.get(response.invocationId)
      let result: ClientToolResult
      if (cached) {
        result = {
          ...cached,
          agentId: response.agentId,
          clientId: response.clientId,
          leaseId: response.leaseId,
          completedAt: new Date().toISOString(),
        }
      } else if (this.uncertain.has(response.invocationId)) {
        result = {
          type: "tool.result",
          invocationId: response.invocationId,
          agentId: response.agentId,
          clientId: response.clientId,
          leaseId: response.leaseId,
          status: "unknown",
          output: "error: client restarted while this tool call was in flight; it was not re-executed",
          completedAt: new Date().toISOString(),
        }
      } else if (Date.now() >= Date.parse(response.deadlineAt)) {
        result = cancelledResult(response, "error: tool call expired before the client could execute it")
      } else {
        result = await this.executeOnce(this.withRemainingTimeout(response))
      }

      this.completed.set(response.invocationId, result)
      this.uncertain.delete(response.invocationId)
      await this.saveJournal()
      await this.request("/results", result)
      this.completed.delete(response.invocationId)
      await this.saveJournal()
    }
  }

  private async flushCompleted(lease: ClientLease): Promise<void> {
    for (const [invocationId, saved] of [...this.completed]) {
      const result: ClientToolResult = {
        ...saved,
        invocationId,
        agentId: this.agentId,
        clientId: this.clientId,
        leaseId: lease.leaseId,
      }
      await this.request("/results", result)
      this.completed.delete(invocationId)
      await this.saveJournal()
    }
  }

  private withRemainingTimeout(invocation: ToolInvocation): ToolInvocation {
    const remaining = Math.max(1_000, Date.parse(invocation.deadlineAt) - Date.now())
    const requested = invocation.args.timeout_ms
    const timeoutMs = typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(Math.max(1_000, Math.trunc(requested)), remaining)
      : remaining
    return { ...invocation, args: { ...invocation.args, timeout_ms: timeoutMs } }
  }

  private async loadJournal(): Promise<void> {
    if (!this.journalPath) return
    let raw: string
    try {
      raw = await fs.readFile(this.journalPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error(`could not read tool journal ${this.journalPath}: ${error instanceof Error ? error.message : String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`tool journal is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const entries = asRecord(parsed)
    if (!entries) throw new Error("tool journal must contain an object")

    for (const [id, entry] of Object.entries(entries)) {
      const item = asRecord(entry)
      if (item?.status === "in_flight" && typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt))) {
        this.uncertain.add(id)
        continue
      }
      const result = parseClientToolResult(entry)
      if (!result || result.invocationId !== id || result.agentId !== this.agentId || result.clientId !== this.clientId) {
        throw new Error(`tool journal contains an invalid entry for ${id}`)
      }
      this.completed.set(id, result)
    }
  }

  private async saveJournal(): Promise<void> {
    if (!this.journalPath) return
    const data: InvocationJournal = Object.fromEntries(this.completed)
    for (const id of this.uncertain) data[id] = { status: "in_flight", startedAt: new Date().toISOString() }

    const directory = path.dirname(this.journalPath)
    const temporary = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await fs.writeFile(temporary, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 })
      await fs.rename(temporary, this.journalPath)
      await fs.chmod(this.journalPath, 0o600)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  private async executeOnce(invocation: ToolInvocation): Promise<ClientToolResult> {
    this.uncertain.add(invocation.invocationId)
    await this.saveJournal()
    return this.host.execute(invocation)
  }
}
