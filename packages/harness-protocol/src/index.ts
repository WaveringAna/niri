export const HARNESS_PROTOCOL_VERSION = "harness-tool/v1" as const

export const CLIENT_TOOL_NAMES = ["shell", "read_file", "edit_file", "image_tool"] as const

export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number]
export type ToolCapability = ClientToolName

export type WorkspaceDescriptor = {
  id: string
  root: string
  home?: string
  imageRoot?: string
  platform?: string
  persistentShell?: boolean
}

export type ClientHello = {
  protocol: typeof HARNESS_PROTOCOL_VERSION
  agentId: string
  clientId: string
  capabilities: ToolCapability[]
  workspace: WorkspaceDescriptor
}

export type ClientLease = {
  agentId: string
  clientId: string
  leaseId: string
  expiresAt: string
}

export type ClientPollRequest = {
  clientId: string
  leaseId: string
  timeoutMs?: number
}

export type ClientDetachRequest = {
  clientId: string
  leaseId: string
}

export type ToolInvocation = {
  type: "tool.call"
  invocationId: string
  agentId: string
  clientId: string
  leaseId: string
  tool: ClientToolName
  args: Record<string, unknown>
  issuedAt: string
  deadlineAt: string
}

export type ClientImageArtifact = {
  path: string
  mime: string
  bytes: number
  dataUrl: string
}

export type ClientToolResult = {
  type: "tool.result"
  invocationId: string
  agentId: string
  clientId: string
  leaseId: string
  status: "ok" | "error" | "cancelled" | "unknown"
  output?: string
  image?: ClientImageArtifact
  completedAt: string
}

export type ClientPollResponse = ToolInvocation | { type: "keepalive"; serverTime: string }

export function isClientToolName(value: unknown): value is ClientToolName {
  return typeof value === "string" && (CLIENT_TOOL_NAMES as readonly string[]).includes(value)
}

export function isToolCapability(value: unknown): value is ToolCapability {
  return isClientToolName(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validDate(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value))
}

export function parseClientHello(value: unknown): ClientHello | null {
  const input = record(value)
  const workspace = input && record(input.workspace)
  if (!input || !workspace) return null
  if (input.protocol !== HARNESS_PROTOCOL_VERSION || !nonEmptyString(input.agentId) || !nonEmptyString(input.clientId)) return null
  if (!Array.isArray(input.capabilities) || !input.capabilities.every(isToolCapability)) return null
  if (!nonEmptyString(workspace.id) || !nonEmptyString(workspace.root)) return null

  return {
    protocol: HARNESS_PROTOCOL_VERSION,
    agentId: input.agentId.trim(),
    clientId: input.clientId.trim(),
    capabilities: [...new Set(input.capabilities)],
    workspace: {
      id: workspace.id.trim(),
      root: workspace.root.trim(),
      ...(nonEmptyString(workspace.home) ? { home: workspace.home.trim() } : {}),
      ...(nonEmptyString(workspace.imageRoot) ? { imageRoot: workspace.imageRoot.trim() } : {}),
      ...(nonEmptyString(workspace.platform) ? { platform: workspace.platform.trim() } : {}),
      ...(typeof workspace.persistentShell === "boolean" ? { persistentShell: workspace.persistentShell } : {}),
    },
  }
}

export function parseClientLease(value: unknown): ClientLease | null {
  const input = record(value)
  if (
    !input ||
    !nonEmptyString(input.agentId) ||
    !nonEmptyString(input.clientId) ||
    !nonEmptyString(input.leaseId) ||
    !validDate(input.expiresAt)
  ) {
    return null
  }
  return {
    agentId: input.agentId.trim(),
    clientId: input.clientId.trim(),
    leaseId: input.leaseId.trim(),
    expiresAt: input.expiresAt,
  }
}

export function parseClientPollRequest(value: unknown): ClientPollRequest | null {
  const input = record(value)
  if (!input || !nonEmptyString(input.clientId) || !nonEmptyString(input.leaseId)) return null
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs))) return null
  return {
    clientId: input.clientId.trim(),
    leaseId: input.leaseId.trim(),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
  }
}

export function parseClientDetachRequest(value: unknown): ClientDetachRequest | null {
  const input = parseClientPollRequest(value)
  return input ? { clientId: input.clientId, leaseId: input.leaseId } : null
}

export function parseToolInvocation(value: unknown): ToolInvocation | null {
  const input = record(value)
  const args = input && record(input.args)
  if (
    !input ||
    !args ||
    input.type !== "tool.call" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
    !nonEmptyString(input.clientId) ||
    !nonEmptyString(input.leaseId) ||
    !isClientToolName(input.tool) ||
    !validDate(input.issuedAt) ||
    !validDate(input.deadlineAt)
  ) {
    return null
  }
  if (Date.parse(input.deadlineAt) < Date.parse(input.issuedAt)) return null
  return {
    type: "tool.call",
    invocationId: input.invocationId.trim(),
    agentId: input.agentId.trim(),
    clientId: input.clientId.trim(),
    leaseId: input.leaseId.trim(),
    tool: input.tool,
    args,
    issuedAt: input.issuedAt,
    deadlineAt: input.deadlineAt,
  }
}

export function parseClientToolResult(value: unknown): ClientToolResult | null {
  const input = record(value)
  if (
    !input ||
    input.type !== "tool.result" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
    !nonEmptyString(input.clientId) ||
    !nonEmptyString(input.leaseId) ||
    !validDate(input.completedAt) ||
    !["ok", "error", "cancelled", "unknown"].includes(String(input.status)) ||
    (input.output !== undefined && typeof input.output !== "string")
  ) {
    return null
  }

  const image = input.image === undefined ? null : record(input.image)
  if (input.image !== undefined && !image) return null
  if (
    image &&
    (!nonEmptyString(image.path) ||
      !nonEmptyString(image.mime) ||
      !/^image\/[a-z0-9.+-]+$/i.test(image.mime) ||
      typeof image.bytes !== "number" ||
      !Number.isSafeInteger(image.bytes) ||
      image.bytes <= 0 ||
      !nonEmptyString(image.dataUrl) ||
      !image.dataUrl.startsWith(`data:${image.mime};base64,`) ||
      input.status !== "ok")
  ) {
    return null
  }

  return {
    type: "tool.result",
    invocationId: input.invocationId.trim(),
    agentId: input.agentId.trim(),
    clientId: input.clientId.trim(),
    leaseId: input.leaseId.trim(),
    status: input.status as ClientToolResult["status"],
    ...(typeof input.output === "string" ? { output: input.output } : {}),
    ...(image
      ? {
          image: {
            path: String(image.path),
            mime: String(image.mime),
            bytes: Number(image.bytes),
            dataUrl: String(image.dataUrl),
          },
        }
      : {}),
    completedAt: input.completedAt,
  }
}

export function parseClientPollResponse(value: unknown): ClientPollResponse | null {
  const invocation = parseToolInvocation(value)
  if (invocation) return invocation
  const input = record(value)
  if (!input || input.type !== "keepalive" || !validDate(input.serverTime)) return null
  return { type: "keepalive", serverTime: input.serverTime }
}
