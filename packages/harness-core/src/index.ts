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

  if (capabilities.has("python")) {
    tools.push(
      functionTool(
        "python",
        "Execute Python in a persistent client-workspace REPL. Variables, imports, functions, parsed data, cwd, and background asyncio tasks persist across calls; top-level await works. Use Python for orchestration, parsing, loops, and reusable state, but run project tests, scripts, CLIs, and dependency checks through the project's native environment with sh(). Preloaded synchronous helpers: read(path, start_line=1, end_line=None, hashline=False); edit(path, target, content), where target is a <line>#<hash> anchor or inclusive anchor range returned by read(..., hashline=True), and empty content deletes it; sh(command), with sh.poll/sh.terminate for resumable commands; out.size/out.tail/out.grep for the previous cell's retained output. niri.whoami() and niri.deadline() are synchronous. Every other niri server API is a coroutine and must be awaited, including niri.budget(), memory, soul, context, schedule, aliases, and Discord methods. Use help(niri) and help(niri.memory) for signatures. Prefer one composed Python call over separate legacy workspace calls.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["execute", "reset"] },
            code: { type: "string", description: "Python source; required for execute." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
        },
      ),
    )
  }

  if (capabilities.has("shell")) {
    tools.push(
      functionTool(
        "shell",
        "Execute a bash command in a fresh non-interactive process. If it is still running after timeout_ms, it remains alive and returns a session_id; use action=poll to keep checking it or action=terminate to stop it explicitly.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["start", "poll", "terminate"], description: "Start a command (default), poll a running session, or explicitly terminate it." },
            command: { type: "string", description: "Bash command; required for action=start." },
            session_id: { type: "string", description: "Shell session id; required for action=poll or action=terminate." },
            max_lines: { type: "integer", minimum: 1, description: "Maximum output lines to return." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000, description: "How long to wait for exit before yielding a resumable session." },
          },
        },
      ),
    )
  }

  if (capabilities.has("read_file")) {
    tools.push(
      functionTool(
        "read_file",
        "Read a bounded file slice. Set hashline=true to prefix each line with a <line>#<hash> anchor for edit_file.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            hashline: { type: "boolean", description: "Prefix each returned line with its hashline edit anchor. Default false." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path"],
        },
      ),
    )
  }

  if (capabilities.has("write_file")) {
    tools.push(
      functionTool(
        "write_file",
        "Create a new UTF-8 text file in the attached client workspace. Fails if the path already exists; use edit_file for existing files.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path", "content"],
        },
      ),
    )
  }

  if (capabilities.has("edit_file")) {
    tools.push(
      functionTool(
        "edit_file",
        "Replace or delete one hashline-anchored line or inclusive range in a file resolved by the attached client.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            target: { type: "string", description: "A '<line>#<hash>' anchor or inclusive '<line>#<hash>-<line>#<hash>' range returned by read_file with hashline=true." },
            content: { type: "string", description: "Replacement text. Empty content deletes the addressed line or range." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path", "target", "content"],
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
