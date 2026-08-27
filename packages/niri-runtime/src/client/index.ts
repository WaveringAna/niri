import { randomUUID } from "node:crypto"
import { NodeToolHost } from "@mira/harness-client-node"
import type { ClientToolExecutor } from "@mira/harness-core"
import { HttpToolClient, type HttpToolClientStatus } from "@mira/harness-server"
import type { ClientToolName, ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@mira/harness-protocol"
import { AGENT_ID, REPO_ROOT } from "../agent-config"
import { issueHostRpcGrant, revokeHostRpcGrant } from "../host-rpc"

export type ConfiguredToolClient = ClientToolExecutor & {
  start(): Promise<void>
  stop(): Promise<void>
  status(): HttpToolClientStatus
}

class LocalToolClient implements ConfiguredToolClient {
  private readonly agentId: string
  private readonly host: NodeToolHost
  private connected = false

  constructor(agentId: string) {
    this.agentId = agentId
    this.host = new NodeToolHost({
      workspace: {
        id: `${agentId}-server`,
        root: process.env.NIRI_CLIENT_WORKSPACE?.trim() || REPO_ROOT,
      },
      hostRpcEndpoint: `http://127.0.0.1:${Number.parseInt(process.env.PORT ?? "3000", 10)}`,
    })
  }

  async start(): Promise<void> {
    await this.host.start()
    this.connected = true
  }

  async stop(): Promise<void> {
    this.connected = false
    await this.host.stop()
  }

  getCapabilities(): ToolCapability[] {
    return this.host.getCapabilities()
  }

  getWorkspace(): WorkspaceDescriptor {
    return this.host.getWorkspace()
  }

  status(): HttpToolClientStatus {
    return {
      connected: this.connected,
      agentId: this.agentId,
      clientId: "local",
      capabilities: this.getCapabilities(),
      workspace: this.getWorkspace(),
      pendingInvocations: 0,
    }
  }

  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<ClientToolResult> {
    const now = Date.now()
    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: randomUUID(),
      agentId: input.agentId,
      tool: input.tool,
      args: input.args,
      issuedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + (input.timeoutMs ?? 30_000)).toISOString(),
    }
    const grant = input.tool === "python" ? issueHostRpcGrant(invocation.invocationId, invocation.deadlineAt) : undefined
    if (grant) invocation.hostRpcGrant = grant
    return this.host.execute(invocation).finally(() => revokeHostRpcGrant(grant))
  }
}

const client = process.env.NIRI_CLIENT?.trim() || "local"

export const clientTools: ConfiguredToolClient = client === "local"
  ? new LocalToolClient(AGENT_ID)
  : new HttpToolClient({ agentId: AGENT_ID, endpoint: client, hostRpcGrants: { issue: issueHostRpcGrant, revoke: revokeHostRpcGrant } })
