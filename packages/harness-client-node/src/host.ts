import path from "node:path"
import type { ClientToolHost } from "@mira/harness-core"
import {
  isToolCapability,
  type ClientImageArtifact,
  type ClientToolName,
  type ClientToolResult,
  type ToolCapability,
  type ToolInvocation,
  type WorkspaceDescriptor,
} from "@mira/harness-protocol"
import {
  CLIENT_HOME,
  CLIENT_WORKSPACE_ROOT,
  IMAGE_ROOT,
  MAX_RESULT_BYTES,
  NODE_TOOL_RUNTIME_GENERATION,
  configureNodeToolRuntime,
  type NodeToolRuntimeOptions,
} from "./config.js"
import { editFile, readBlobChunk, readFile, readImageForModel, runCommandResult, writeFile } from "./tools.js"
import { closeShellSessions, UnknownShellSessionError } from "./shell.js"
import { PythonKernelManager } from "./python-kernel.js"

export type NodeToolHostOptions = {
  capabilities?: Iterable<ToolCapability>
  workspace?: Partial<WorkspaceDescriptor>
  runtime?: NodeToolRuntimeOptions
  hostRpcEndpoint?: string
}

const ALL_CAPABILITIES: ToolCapability[] = ["python", "shell", "read_file", "write_file", "edit_file", "image_tool", "read_blob"]

export function parseToolCapabilities(value?: string): ToolCapability[] {
  const raw = value?.trim()
  if (!raw) return [...ALL_CAPABILITIES]
  const requested = raw.split(",").map((item) => item.trim()).filter(Boolean)
  const unknown = requested.filter((item) => !isToolCapability(item))
  if (unknown.length > 0) throw new Error(`unknown client capabilities: ${unknown.join(", ")}`)
  if (requested.length === 0) throw new Error("at least one client capability is required")
  return [...new Set(requested as ToolCapability[])]
}

function errorResult(invocation: ToolInvocation, error: unknown): ClientToolResult {
  return {
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: invocation.agentId,
    status: "error",
    output: `error: ${error instanceof Error ? error.message : String(error)}`,
    completedAt: new Date().toISOString(),
  }
}

class CancelledExecutionError extends Error {}

function boundedText(output: string): string {
  const bytes = Buffer.from(output, "utf8")
  if (bytes.length <= MAX_RESULT_BYTES) return output
  const prefix = bytes.subarray(0, MAX_RESULT_BYTES).toString("utf8").replace(/\uFFFD$/, "")
  return `${prefix}\n[truncated at ${MAX_RESULT_BYTES} bytes for transport]`
}

export class NodeToolHost implements ClientToolHost {
  private readonly capabilities: ToolCapability[]
  private readonly workspace: WorkspaceDescriptor
  private readonly runtimeGeneration: number
  private started = false
  private readonly python = new PythonKernelManager()
  private hostRpcEndpoint: string | undefined

  constructor(options: NodeToolHostOptions = {}) {
    const workspaceRoot = options.runtime?.workspaceRoot ?? options.workspace?.root
    const home = options.runtime?.home ?? options.workspace?.home
    const imageRoot = options.runtime?.imageRoot ?? options.workspace?.imageRoot
    this.runtimeGeneration = configureNodeToolRuntime({
      ...options.runtime,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(home ? { home } : {}),
      ...(imageRoot ? { imageRoot } : {}),
    })
    this.capabilities = [...new Set(options.capabilities ?? parseToolCapabilities(process.env.HARNESS_CLIENT_CAPABILITIES))]
    if (this.capabilities.length === 0) throw new Error("at least one client capability is required")
    this.hostRpcEndpoint = options.hostRpcEndpoint?.trim() || undefined
    this.workspace = {
      id: options.workspace?.id?.trim() || path.basename(CLIENT_WORKSPACE_ROOT) || "workspace",
      root: CLIENT_WORKSPACE_ROOT,
      home: CLIENT_HOME,
      imageRoot: IMAGE_ROOT,
      platform: options.workspace?.platform?.trim() || process.platform,
      persistentShell: false,
      shellSessionResults: this.capabilities.includes("shell"),
      persistentPython: this.capabilities.includes("python"),
    }
  }

  setHostRpcEndpoint(endpoint: string | null): void {
    this.hostRpcEndpoint = endpoint?.trim() || undefined
  }

  getCapabilities(): ToolCapability[] {
    return this.capabilities.filter((capability) => capability !== "python" || this.python.isReady())
  }

  getWorkspace(): WorkspaceDescriptor {
    return { ...this.workspace, persistentPython: this.getCapabilities().includes("python") }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.assertActiveRuntime()
    if (this.capabilities.includes("python")) {
      const ready = await this.python.probe()
      if (!ready) console.warn("[python] kernel unavailable; python capability stays hidden for this host")
    }
    this.started = true
  }

  async stop(): Promise<void> {
    await this.python.stop()
    if (this.runtimeGeneration === NODE_TOOL_RUNTIME_GENERATION) await closeShellSessions()
    this.started = false
  }

  async execute(invocation: ToolInvocation): Promise<ClientToolResult> {
    if (!this.capabilities.includes(invocation.tool)) {
      return errorResult(invocation, new Error(`client does not expose ${invocation.tool}`))
    }
    if (Date.now() >= Date.parse(invocation.deadlineAt)) {
      return {
        ...errorResult(invocation, new Error("tool call expired before execution")),
        status: "cancelled",
      }
    }

    try {
      this.assertActiveRuntime()
      await this.start()
      if (invocation.tool === "shell") {
        try {
          const result = await runCommandResult({
            action: invocation.args.action === "poll" || invocation.args.action === "terminate" ? invocation.args.action : "start",
            ...(typeof invocation.args.command === "string" ? { command: invocation.args.command } : {}),
            ...(typeof invocation.args.session_id === "string" ? { sessionId: invocation.args.session_id } : {}),
            ...(typeof invocation.args.max_lines === "number" ? { maxLines: invocation.args.max_lines } : {}),
            ...(typeof invocation.args.timeout_ms === "number" ? { timeoutMs: invocation.args.timeout_ms } : {}),
          })
          return { type: "tool.result", invocationId: invocation.invocationId, agentId: invocation.agentId,
            status: "ok", output: boundedText(result.output), shell: result.shell, completedAt: new Date().toISOString() }
        } catch (error) {
          if (error instanceof UnknownShellSessionError) {
            return { type: "tool.result", invocationId: invocation.invocationId, agentId: invocation.agentId,
              status: "unknown", output: `[unknown shell session ${error.sessionId}]`,
              shell: { sessionId: error.sessionId, status: "unknown", output: "", exitCode: null, signal: null, terminationRequested: false },
              completedAt: new Date().toISOString() }
          }
          throw error
        }
      }
      const output = await this.executeTool(invocation.tool, invocation.args, invocation)
      return {
        type: "tool.result", invocationId: invocation.invocationId, agentId: invocation.agentId,
        status: "ok", ...(typeof output === "string" ? { output: boundedText(output) } : { image: output }), completedAt: new Date().toISOString(),
      }
    } catch (error) {
      const result = errorResult(invocation, error)
      return error instanceof CancelledExecutionError ? { ...result, status: "cancelled" } : result
    }
  }

  private assertActiveRuntime(): void {
    if (this.runtimeGeneration !== NODE_TOOL_RUNTIME_GENERATION) {
      throw new Error("this NodeToolHost was superseded by another host in the same process")
    }
  }

  private async executeTool(tool: ClientToolName, args: Record<string, unknown>, invocation: ToolInvocation): Promise<string | ClientImageArtifact> {
    switch (tool) {
      // Shell is handled in execute() so its typed session result can cross the protocol.
      case "shell": throw new Error("shell must be handled by execute")
      case "python": {
        const action = args.action === "reset" ? "reset" : "execute"
        if (action === "reset") {
          if (!this.python.isReady()) return "Python kernel is not running."
          await this.python.reset()
          return "Python kernel reset."
        }
        const code = String(args.code ?? "")
        if (!code.trim()) throw new Error("Python code is required")
        const result = await this.python.execute(code, {
          agentId: invocation.agentId,
          invocationId: invocation.invocationId,
          deadlineAt: invocation.deadlineAt,
          ...(this.hostRpcEndpoint ? { hostRpcEndpoint: this.hostRpcEndpoint } : {}),
          ...(invocation.hostRpcGrant ? { hostRpcGrant: invocation.hostRpcGrant } : {}),
        })
        if (result.status === "cancelled") throw new CancelledExecutionError(result.output || "Python execution cancelled")
        if (result.status !== "ok") throw new Error(result.output || `Python execution ${result.status}`)
        return result.output || "(no output)"
      }
      case "read_file": {
        const output = await readFile(
          String(args.path ?? ""),
          typeof args.start_line === "number" ? args.start_line : undefined,
          typeof args.end_line === "number" ? args.end_line : undefined,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          args.hashline === true,
        )
        return output || "(empty file)"
      }
      case "write_file": {
        const result = await writeFile(
          String(args.path ?? ""),
          String(args.content ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
        if (!result.ok) throw new Error(result.message)
        return result.message
      }
      case "edit_file": {
        const result = await editFile(
          String(args.path ?? ""),
          String(args.target ?? ""),
          String(args.content ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
        if (!result.ok) throw new Error(result.message)
        return result.message
      }
      case "image_tool": {
        return readImageForModel(
          String(args.path ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
      }
      case "read_blob": {
        return readBlobChunk(
          String(args.path ?? ""),
          typeof args.offset === "number" ? args.offset : undefined,
          typeof args.max_bytes === "number" ? args.max_bytes : undefined,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
      }
    }
  }
}
