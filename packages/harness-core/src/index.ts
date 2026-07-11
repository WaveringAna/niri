import type {
  ClientToolName,
  ClientToolResult,
  ToolCapability,
  ToolInvocation,
  WorkspaceDescriptor,
} from "@mira/harness-protocol"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonSchema = { [key: string]: JsonValue }

export type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface ClientToolExecutor {
  getCapabilities(): ToolCapability[]
  getWorkspace(): WorkspaceDescriptor | null
  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<ClientToolResult>
}

export interface ClientToolHost {
  start(): Promise<void>
  stop(): Promise<void>
  getCapabilities(): ToolCapability[]
  getWorkspace(): WorkspaceDescriptor
  execute(invocation: ToolInvocation): Promise<ClientToolResult>
}

export type ClientToolCatalogOptions = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
}

const functionTool = (name: ClientToolName, description: string, parameters: JsonSchema): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters },
})

export function createClientToolCatalog(options: ClientToolCatalogOptions = {}): ToolDefinition[] {
  const capabilities = new Set(options.clientCapabilities ?? [])
  const imageRoot = options.workspace?.imageRoot || options.workspace?.root || "the attached client workspace"
  const tools: ToolDefinition[] = []

  if (capabilities.has("shell")) {
    tools.push(
      functionTool(
        "shell",
        "Execute a bash command in the attached client workspace. The shell is stateful, so working-directory and environment changes persist on that client.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            max_lines: { type: "integer", minimum: 1, description: "Maximum lines to return." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["command"],
        },
      ),
    )
  }

  if (capabilities.has("read_file")) {
    tools.push(
      functionTool(
        "read_file",
        "Read a file resolved by the attached client, with optional inclusive line bounds.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path"],
        },
      ),
    )
  }

  if (capabilities.has("edit_file")) {
    tools.push(
      functionTool(
        "edit_file",
        "Replace one exact text occurrence in a file resolved by the attached client.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            old_text: { type: "string", minLength: 1 },
            new_text: { type: "string" },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path", "old_text", "new_text"],
        },
      ),
    )
  }

  if (capabilities.has("image_tool")) {
    tools.push(
      functionTool(
        "image_tool",
        `Attach a bounded image from ${imageRoot}.`,
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            note: { type: "string" },
            detail: { type: "string", enum: ["auto", "low", "high"] },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path"],
        },
      ),
    )
  }

  return tools
}
