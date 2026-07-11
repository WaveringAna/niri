import { randomUUID, timingSafeEqual } from "node:crypto"
import type { ClientToolExecutor } from "@mira/harness-core"
import {
  type ClientHello,
  type ClientLease,
  type ClientPollResponse,
  type ClientToolResult,
  type ClientToolName,
  type ToolCapability,
  type ToolInvocation,
  type WorkspaceDescriptor,
  parseClientHello,
  parseClientDetachRequest,
  parseClientPollRequest,
  parseClientToolResult,
} from "@mira/harness-protocol"

type PendingInvocation = {
  invocation: ToolInvocation
  resolve: (result: ClientToolResult) => void
  timeout: ReturnType<typeof setTimeout>
}

export type ClientBrokerOptions = {
  agentId: string
  token?: string
  expectedClientId?: string
  leaseTtlMs?: number
  activeClientTtlMs?: number
}

export type ClientBrokerStatus = {
  connected: boolean
  agentId: string
  clientId?: string
  capabilities: ToolCapability[]
  workspace: WorkspaceDescriptor | null
  lastSeenAt?: string
  pendingInvocations: number
}

const ACTIVE_CLIENT_TTL_MS = 45_000
const DEFAULT_LEASE_TTL_MS = 60_000
const MAX_TOOL_TIMEOUT_MS = 10 * 60_000

function nowIso(): string {
  return new Date().toISOString()
}

function tokenMatches(expected: string, authorization: unknown): boolean {
  if (typeof authorization !== "string") return false
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const provided = match?.[1]?.trim() ?? ""
  if (!provided) return false
  const expectedBytes = Buffer.from(expected)
  const providedBytes = Buffer.from(provided)
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}

function errorResult(input: {
  invocationId: string
  agentId: string
  clientId: string
  leaseId: string
  output: string
  status?: ClientToolResult["status"]
}): ClientToolResult {
  return {
    type: "tool.result",
    invocationId: input.invocationId,
    agentId: input.agentId,
    clientId: input.clientId,
    leaseId: input.leaseId,
    status: input.status ?? "error",
    output: input.output,
    completedAt: nowIso(),
  }
}

export class ClientToolBroker implements ClientToolExecutor {
  private readonly agentId: string
  private readonly token: string
  private readonly expectedClientId: string | undefined
  private readonly leaseTtlMs: number
  private readonly activeClientTtlMs: number
  private hello: ClientHello | null = null
  private lease: ClientLease | null = null
  private lastSeenAtMs = 0
  private readonly pending = new Map<string, PendingInvocation>()
  private readonly pollWaiters = new Set<() => void>()

  constructor(options: ClientBrokerOptions) {
    this.agentId = options.agentId
    this.token = options.token?.trim() ?? ""
    this.expectedClientId = options.expectedClientId?.trim() || undefined
    const requestedLeaseTtl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.leaseTtlMs = Number.isFinite(requestedLeaseTtl)
      ? Math.max(100, Math.trunc(requestedLeaseTtl))
      : DEFAULT_LEASE_TTL_MS
    const requestedActiveTtl = options.activeClientTtlMs ?? ACTIVE_CLIENT_TTL_MS
    this.activeClientTtlMs = Number.isFinite(requestedActiveTtl)
      ? Math.max(100, Math.trunc(requestedActiveTtl))
      : ACTIVE_CLIENT_TTL_MS
  }

  isAuthorized(authorization: unknown): boolean {
    return Boolean(this.token) && tokenMatches(this.token, authorization)
  }

  hasConfiguredToken(): boolean {
    return Boolean(this.token)
  }

  register(rawHello: unknown): ClientLease {
    const hello = parseClientHello(rawHello)
    if (!hello) throw new Error("invalid harness tool client hello")
    if (hello.agentId !== this.agentId) throw new Error("tool client is paired with a different agent")
    if (this.expectedClientId && hello.clientId !== this.expectedClientId) {
      throw new Error(`tool client ${hello.clientId} is not allowed for agent ${this.agentId}`)
    }
    if (this.hello && this.hello.clientId !== hello.clientId) {
      if (this.isConnected() || this.pending.size > 0) {
        throw new Error(`agent ${this.agentId} already has an attached tool client`)
      }
      this.resolvePendingUnknown("the attached tool client changed before returning a result")
    }

    this.hello = hello
    this.lastSeenAtMs = Date.now()
    this.lease = {
      agentId: this.agentId,
      clientId: hello.clientId,
      leaseId: randomUUID(),
      expiresAt: new Date(Date.now() + this.leaseTtlMs).toISOString(),
    }
    this.notifyPollers()
    return this.lease
  }

  getCapabilities(): ToolCapability[] {
    return this.isConnected() ? [...(this.hello?.capabilities ?? [])] : []
  }

  getWorkspace(): WorkspaceDescriptor | null {
    return this.isConnected() && this.hello ? { ...this.hello.workspace } : null
  }

  status(): ClientBrokerStatus {
    return {
      connected: this.isConnected(),
      agentId: this.agentId,
      ...(this.hello ? { clientId: this.hello.clientId } : {}),
      capabilities: this.getCapabilities(),
      workspace: this.getWorkspace(),
      ...(this.lastSeenAtMs ? { lastSeenAt: new Date(this.lastSeenAtMs).toISOString() } : {}),
      pendingInvocations: this.pending.size,
    }
  }

  async poll(raw: unknown): Promise<ClientPollResponse> {
    const input = parseClientPollRequest(raw)
    if (!input) throw new Error("invalid tool client poll request")
    this.assertLease(input.clientId, input.leaseId)
    this.touch()

    const next = [...this.pending.values()][0]
    if (next) {
      next.invocation.leaseId = this.lease!.leaseId
      return next.invocation
    }

    const requestedTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs : 25_000
    const timeoutMs = Math.max(1_000, Math.min(30_000, Math.trunc(requestedTimeout)))
    return new Promise<ClientPollResponse>((resolve) => {
      const finish = (response: ClientPollResponse) => {
        clearTimeout(wakeAt)
        this.pollWaiters.delete(wake)
        resolve(response)
      }
      const wake = () => {
        if (!this.lease || this.lease.leaseId !== input.leaseId) {
          finish({ type: "keepalive", serverTime: nowIso() })
          return
        }
        const pending = [...this.pending.values()][0]
        if (!pending || !this.lease) return
        pending.invocation.leaseId = this.lease.leaseId
        finish(pending.invocation)
      }
      const wakeAt = setTimeout(() => finish({ type: "keepalive", serverTime: nowIso() }), timeoutMs)
      wakeAt.unref?.()
      this.pollWaiters.add(wake)
    })
  }

  acceptResult(raw: unknown): { ok: true; duplicate?: boolean } {
    const result = parseClientToolResult(raw)
    if (!result) throw new Error("invalid harness tool result")
    if (result.agentId !== this.agentId) throw new Error("tool result is paired with a different agent")

    const pending = this.pending.get(result.invocationId)
    if (!pending) {
      this.assertLease(result.clientId, result.leaseId)
      this.touch()
      return { ok: true, duplicate: true }
    }
    if (pending.invocation.clientId !== result.clientId) throw new Error("tool result client does not own this invocation")
    if (pending.invocation.leaseId !== result.leaseId) throw new Error("tool result lease does not own this invocation")

    clearTimeout(pending.timeout)
    this.pending.delete(result.invocationId)
    this.touch()
    pending.resolve(result)
    return { ok: true }
  }

  detach(raw: unknown): { ok: true } {
    const input = parseClientDetachRequest(raw)
    if (!input) throw new Error("invalid tool client detach request")
    this.assertLease(input.clientId, input.leaseId)
    this.resolvePendingUnknown("the tool client detached before returning a result")
    this.hello = null
    this.lease = null
    this.lastSeenAtMs = 0
    this.notifyPollers()
    return { ok: true }
  }

  async execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<ClientToolResult> {
    const invocationId = randomUUID()
    if (input.agentId !== this.agentId) {
      return errorResult({
        invocationId,
        agentId: input.agentId,
        clientId: "unbound",
        leaseId: "unbound",
        output: "error: client executor belongs to a different agent",
      })
    }
    if (!this.isConnected() || !this.hello || !this.lease) {
      return errorResult({
        invocationId,
        agentId: this.agentId,
        clientId: this.expectedClientId ?? "unbound",
        leaseId: "unbound",
        output: `error: ${input.tool} is unavailable because no authenticated client workspace is attached`,
      })
    }
    if (!this.hello.capabilities.includes(input.tool)) {
      return errorResult({
        invocationId,
        agentId: this.agentId,
        clientId: this.hello.clientId,
        leaseId: this.lease.leaseId,
        output: `error: attached client does not expose ${input.tool}`,
      })
    }

    const rawTimeout = input.timeoutMs ?? 30_000
    const requestedTimeout = Number.isFinite(rawTimeout)
      ? Math.max(1_000, Math.min(MAX_TOOL_TIMEOUT_MS, Math.trunc(rawTimeout)))
      : 30_000
    const deadlineMs = Date.now() + requestedTimeout + 5_000

    return new Promise<ClientToolResult>((resolve) => {
      const invocation: ToolInvocation = {
        type: "tool.call",
        invocationId,
        agentId: this.agentId,
        clientId: this.hello!.clientId,
        leaseId: this.lease!.leaseId,
        tool: input.tool,
        args: input.args,
        issuedAt: nowIso(),
        deadlineAt: new Date(deadlineMs).toISOString(),
      }
      const timeout = setTimeout(() => {
        if (!this.pending.delete(invocationId)) return
        resolve(
          errorResult({
            invocationId,
            agentId: this.agentId,
            clientId: invocation.clientId,
            leaseId: invocation.leaseId,
            status: "unknown",
            output: `error: ${input.tool} result is unknown because the client did not return before its deadline`,
          }),
        )
      }, requestedTimeout + 5_000)
      timeout.unref?.()
      this.pending.set(invocationId, { invocation, resolve, timeout })
      this.notifyPollers()
    })
  }

  private notifyPollers(): void {
    for (const wake of [...this.pollWaiters]) wake()
  }

  private resolvePendingUnknown(reason: string): void {
    for (const [invocationId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      this.pending.delete(invocationId)
      pending.resolve(
        errorResult({
          invocationId,
          agentId: this.agentId,
          clientId: pending.invocation.clientId,
          leaseId: pending.invocation.leaseId,
          status: "unknown",
          output: `error: ${reason}`,
        }),
      )
    }
  }

  private isConnected(): boolean {
    if (!this.hello || !this.lease) return false
    const leaseExpiresAt = Date.parse(this.lease.expiresAt)
    return Date.now() - this.lastSeenAtMs < this.activeClientTtlMs && Date.now() < leaseExpiresAt
  }

  private touch(): void {
    this.lastSeenAtMs = Date.now()
    if (!this.lease) return
    this.lease = { ...this.lease, expiresAt: new Date(Date.now() + this.leaseTtlMs).toISOString() }
  }

  private assertLease(clientId: unknown, leaseId: unknown): void {
    if (!this.isConnected() || !this.hello || !this.lease) throw new Error("tool client lease has expired")
    if (clientId !== this.hello.clientId || leaseId !== this.lease.leaseId) throw new Error("invalid tool client lease")
  }
}
