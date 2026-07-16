import { emit } from "../stream"
import { callMcpTool, getMcpToolDefinitions, hasMcpTool } from "../mcp"
import { buildToolHandlers } from "./loop-tool-registry"
import { executeToolCall, pushToolMessage, recordToolResult } from "./loop-tool-runtime"
import type { FunctionToolCall } from "./loop-shared"
import type { LoopHooks, LoopState } from "./types"

function skipRemainingToolCalls(
  convId: number,
  state: LoopState,
  calls: readonly FunctionToolCall[],
  startIndex: number,
  source: string,
): void {
  calls.slice(startIndex).forEach((pendingCall) => {
    const skippedContent = `skipped: interrupted by incoming ${source} event.`
    const result = pushToolMessage(convId, state, pendingCall, skippedContent)
    emit({ type: "tool", name: pendingCall.function.name, args: { _skipped: true }, result })
  })
}

function maybeInterruptAfterTool(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
  nextIndex: number,
): boolean {
  if (state.pendingInputs.length === 0) return false

  const incoming = state.pendingInputs.shift()!
  hooks.injectIncomingEvent(convId, incoming)
  skipRemainingToolCalls(convId, state, calls, nextIndex, incoming.source)
  return true
}

export async function processToolCalls(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
): Promise<boolean> {
  const handlers = buildToolHandlers(hooks)
  for (const tool of getMcpToolDefinitions()) {
    const name = tool.function.name
    handlers[name] = async (ctx) => {
      if (!hasMcpTool(name)) throw new Error(`MCP tool ${name} is disconnected`)
      console.log(`[mcp tool] ${name}`)
      const result = await callMcpTool(name, ctx.args)
      recordToolResult(ctx.convId, ctx.state, ctx.call, name, ctx.args, result)
      emit({ type: "tool", name, args: ctx.args, result })
      return {}
    }
  }
  const allowedTools = new Set(hooks.getTools().map((tool) => tool.function.name))

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    if (!allowedTools.has(call.function.name)) {
      const result = pushToolMessage(convId, state, call, `error: ${call.function.name} is not available for this agent right now`)
      emit({ type: "tool", name: call.function.name, args: { _unavailable: true }, result })
      continue
    }
    const outcome = await executeToolCall(convId, state, hooks, handlers, call)

    if (outcome.shouldRest) return true
    if (outcome.isWait) continue

    const interrupted = maybeInterruptAfterTool(convId, state, hooks, calls, i + 1)
    if (interrupted) return false
  }

  return false
}
