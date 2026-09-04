import type { ToolDefinition } from "@mira/harness-core"
import type {
  AgentRuntime,
  FunctionToolCall,
  LoopHooks,
  LoopState,
  ToolArgs,
  ToolExecutionOutcome,
  ToolHandler,
  ToolModule,
  ToolModuleContext,
} from "./types.js"

/**
 * Tool registration and dispatch.
 *
 * Replaces `@niri/runtime`'s `loop-tool-registry.ts`, an 800-line file that
 * statically imported Discord state, posture, memory, the work ledger, process
 * jobs, and delegation. Adding a tool meant editing that file; a harness that
 * wanted none of them had no way to say so. Modules now contribute
 * independently and the loop only sees the merged surface.
 */

/** Tools that block on external input, so they don't count as work in flight. */
const WAIT_TOOL_NAMES = new Set(["wait", "wait_then_continue"])

export function isWaitTool(name: string): boolean {
  return WAIT_TOOL_NAMES.has(name)
}

export type ResolvedTools = {
  definitions: ToolDefinition[]
  handlers: Record<string, ToolHandler>
}

/**
 * Merges every module's contribution for this turn.
 *
 * A later module may not silently take over an earlier module's tool name —
 * that is how a harness ends up with two `search` tools and a coin-flip for
 * which one runs — so collisions throw at assembly time.
 */
export function resolveTools(modules: readonly ToolModule[], ctx: ToolModuleContext): ResolvedTools {
  const definitions: ToolDefinition[] = []
  const handlers: Record<string, ToolHandler> = {}
  const owners = new Map<string, string>()

  for (const module of modules) {
    for (const definition of module.definitions(ctx)) {
      const name = definition.function.name
      const owner = owners.get(name)
      if (owner) {
        throw new Error(`tool "${name}" is registered by both "${owner}" and "${module.name}"`)
      }
      owners.set(name, module.name)
      definitions.push(definition)
    }
    for (const [name, handler] of Object.entries(module.handlers(ctx))) {
      handlers[name] = handler
    }
  }

  // A tool the model can see but nothing can run is a latent runtime error.
  for (const [name, owner] of owners) {
    if (!handlers[name]) throw new Error(`module "${owner}" declares tool "${name}" but provides no handler`)
  }

  return { definitions, handlers }
}

export function parseToolArguments(rawArgs: unknown): { ok: true; args: ToolArgs } | { ok: false; error: string } {
  if (rawArgs === undefined || rawArgs === null) return { ok: true, args: {} }
  if (typeof rawArgs === "object") return { ok: true, args: rawArgs as ToolArgs }
  if (typeof rawArgs !== "string") return { ok: false, error: `expected an object or JSON string, got ${typeof rawArgs}` }

  const trimmed = rawArgs.trim()
  if (!trimmed) return { ok: true, args: {} }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, args: parsed as ToolArgs }
    return { ok: false, error: "tool arguments must be a JSON object" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Truncates and redacts a value before it goes onto the event stream. */
function streamToolValue(value: unknown, key = "", depth = 0): unknown {
  if (/(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)) return "[redacted]"
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 997)}...` : value
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (depth >= 4) return "[nested value]"
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => streamToolValue(item, key, depth + 1))
  if (!value || typeof value !== "object") return String(value ?? "")
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 32)
      .map(([childKey, childValue]) => [childKey, streamToolValue(childValue, childKey, depth + 1)]),
  )
}

export function streamToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, streamToolValue(value, key)]))
}

/** Appends a tool-role message to state and the durable transcript. */
export function pushToolMessage(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  call: FunctionToolCall,
  content: string,
): string {
  state.conversation.push({ role: "tool", tool_call_id: call.id, content })
  runtime.transcript.logMessage(convId, "tool", content, undefined, call.id)
  return content
}

/** Records a tool result and publishes it to the event stream. */
export function recordToolResult(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  call: FunctionToolCall,
  name: string,
  args: Record<string, unknown>,
  content: string,
): string {
  const result = pushToolMessage(runtime, convId, state, call, content)
  runtime.events.emit({ type: "tool", name, args: streamToolArgs(args), result })
  return result
}

export function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`
}

function hasToolResponse(state: LoopState, call: FunctionToolCall): boolean {
  return state.conversation.some(
    (message) =>
      message.role === "tool" &&
      (message as { tool_call_id?: string }).tool_call_id === call.id,
  )
}

/**
 * Executes one tool call end-to-end.
 *
 * Every failure path still writes a tool-role message: a tool call the provider
 * made but never sees answered corrupts the conversation on the next request.
 */
export async function executeToolCall(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  handlers: Record<string, ToolHandler>,
  call: FunctionToolCall,
  hooks: LoopHooks,
): Promise<ToolExecutionOutcome> {
  const parsed = parseToolArguments(call.function.arguments)
  if (!parsed.ok) {
    recordToolResult(
      runtime, convId, state, call, call.function.name,
      { _parse_error: parsed.error },
      `error: invalid arguments for ${call.function.name}: ${parsed.error}`,
    )
    return {}
  }

  const waiting = isWaitTool(call.function.name)
  if (!waiting) state.toolInFlight = true

  try {
    const handler = handlers[call.function.name]
    if (!handler) {
      recordToolResult(
        runtime, convId, state, call, call.function.name,
        { _unknown_tool: call.function.name },
        `error: unknown tool ${call.function.name}`,
      )
      return {}
    }
    return await handler({ convId, state, runtime, hooks, call, args: parsed.args })
  } catch (err) {
    const errorText = toolError(err)
    if (!hasToolResponse(state, call)) {
      recordToolResult(runtime, convId, state, call, call.function.name, { _handler_error: true }, errorText)
    } else {
      console.warn(`[loop] ${call.function.name} failed after recording tool response: ${errorText}`)
    }
    return {}
  } finally {
    if (!waiting) {
      state.toolInFlight = false
      hooks.flushDeferredEvents()
    }
  }
}
