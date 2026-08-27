export const CLIENT_TOOL_NAMES = ["python", "shell", "read_file", "write_file", "edit_file", "image_tool", "read_blob"] as const

export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number]
export type ToolCapability = ClientToolName

export type WorkspaceDescriptor = {
  id: string
  root: string
  home?: string
  imageRoot?: string
  platform?: string
  persistentShell?: boolean
  persistentPython?: boolean
}

export type ToolInvocation = {
  type: "tool.call"
  invocationId: string
  agentId: string
  tool: ClientToolName
  args: Record<string, unknown>
  issuedAt: string
  deadlineAt: string
  /** Short-lived opaque lease for client->host RPC during this invocation. */
  hostRpcGrant?: string
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
  status: "ok" | "error" | "cancelled" | "unknown"
  output?: string
  image?: ClientImageArtifact
  completedAt: string
}

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

export function parseToolInvocation(value: unknown): ToolInvocation | null {
  const input = record(value)
  const args = input && record(input.args)
  if (
    !input ||
    !args ||
    input.type !== "tool.call" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
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
    tool: input.tool,
    args,
    issuedAt: input.issuedAt,
    deadlineAt: input.deadlineAt,
    ...(nonEmptyString(input.hostRpcGrant) ? { hostRpcGrant: input.hostRpcGrant } : {}),
  }
}

export function parseClientToolResult(value: unknown): ClientToolResult | null {
  const input = record(value)
  if (
    !input ||
    input.type !== "tool.result" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
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


export const HOST_RPC_METHODS = [
  "memory.search", "memory.read", "memory.list", "memory.grep", "memory.write",
  "memory.alias.list", "memory.alias.set", "memory.alias.remove",
  "soul.read", "soul.write",
  "context.grep", "context.describe", "context.expand",
  "discord.inbox", "discord.backread", "discord.search", "discord.channels",
  "loop.budget",
  "schedule.create", "schedule.list", "schedule.cancel",
] as const

export type HostRpcMethod = (typeof HOST_RPC_METHODS)[number]

export type HostRpcRequest = {
  type: "host.call"
  requestId: string
  outerInvocationId: string
  method: HostRpcMethod
  args: Record<string, unknown>
  issuedAt: string
  deadlineAt: string
}

export type HostRpcResult = {
  type: "host.result"
  requestId: string
  status: "ok" | "error" | "cancelled"
  result?: unknown
  error?: { code: string; message: string }
  completedAt: string
}

export function isHostRpcMethod(value: unknown): value is HostRpcMethod {
  return typeof value === "string" && (HOST_RPC_METHODS as readonly string[]).includes(value)
}

export function parseHostRpcRequest(value: unknown): HostRpcRequest | null {
  const input = record(value)
  const args = input && record(input.args)
  if (!input || !args || input.type !== "host.call" || !nonEmptyString(input.requestId) ||
      !nonEmptyString(input.outerInvocationId) || !isHostRpcMethod(input.method) ||
      !validDate(input.issuedAt) || !validDate(input.deadlineAt) ||
      Date.parse(input.deadlineAt) < Date.parse(input.issuedAt)) return null
  return { type: "host.call", requestId: input.requestId.trim(), outerInvocationId: input.outerInvocationId.trim(),
    method: input.method, args, issuedAt: input.issuedAt, deadlineAt: input.deadlineAt }
}

export function parseHostRpcResult(value: unknown): HostRpcResult | null {
  const input = record(value)
  if (!input || input.type !== "host.result" || !nonEmptyString(input.requestId) ||
      !["ok", "error", "cancelled"].includes(String(input.status)) || !validDate(input.completedAt)) return null
  const error = input.error === undefined ? null : record(input.error)
  if (input.status === "ok" && error) return null
  if (input.status !== "ok" && (!error || !nonEmptyString(error.code) || !nonEmptyString(error.message))) return null
  return { type: "host.result", requestId: input.requestId.trim(), status: input.status as HostRpcResult["status"],
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(error ? { error: { code: String(error.code), message: String(error.message) } } : {}), completedAt: input.completedAt }
}
