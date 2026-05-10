import OpenAI from "openai"
import { logMessage } from "../db"
import { emit } from "../stream"
import { latestAssistantContent } from "./loop-content"
import type {
  ArgTuple,
  FunctionToolCall,
  ToolArgKey,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandler,
} from "./loop-shared"
import type { LoopHooks, LoopState } from "./types"
import { parseToolArguments } from "./util"

type StandardToolSpec<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
> = {
  name: string
  logArgKeys: LogKeys
  runArgKeys: RunKeys
  run: (...values: ArgTuple<RunKeys>) => Promise<string>
  emptyFallback?: string
  emitArgKeys?: EmitKeys
  previewChars?: number
}

/**
 * Appends a tool-role message to conversation state and persistence logs.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param call - Tool call being satisfied.
 * @param content - Tool result content.
 * @returns Persisted tool content.
 */
export function pushToolMessage(convId: number, state: LoopState, call: FunctionToolCall, content: string): string {
  const toolMsg = {
    role: "tool" as const,
    tool_call_id: call.id,
    content,
  }
  state.conversation.push(toolMsg)
  logMessage(convId, "tool", toolMsg.content, undefined, call.id)
  return toolMsg.content
}

function hasToolResponse(state: LoopState, call: FunctionToolCall): boolean {
  return state.conversation.some(
    (message) =>
      message.role === "tool" &&
      (message as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === call.id,
  )
}

/**
 * Records a tool result and emits it to stream subscribers.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param call - Tool call being satisfied.
 * @param name - Tool name.
 * @param args - Tool args payload.
 * @param content - Tool result content.
 * @returns Persisted tool content.
 */
export function recordToolResult(
  convId: number,
  state: LoopState,
  call: FunctionToolCall,
  name: string,
  args: Record<string, unknown>,
  content: string,
): string {
  const result = pushToolMessage(convId, state, call, content)
  emit({ type: "tool", name, args, result })
  return result
}

/**
 * Normalizes thrown values into tool-friendly error text.
 *
 * @param err - Unknown thrown value.
 * @returns Error string prefixed with `error:`.
 */
export function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`
}

function argsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): ArgTuple<K> {
  return keys.map((key) => args[key]) as ArgTuple<K>
}

function pickArgsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): Record<K[number], ToolArgs[K[number]]> {
  return Object.fromEntries(keys.map((key) => [key, args[key]])) as Record<K[number], ToolArgs[K[number]]>
}

/**
 * Executes a standard "run command then record result" tool pattern.
 *
 * @param ctx - Tool execution context.
 * @param spec - Declarative tool behavior and argument mapping.
 * @returns Empty outcome object for continued loop flow.
 */
export async function runStandardTool<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
>(
  ctx: ToolExecutionContext,
  spec: StandardToolSpec<RunKeys, LogKeys, EmitKeys>,
): Promise<ToolExecutionOutcome> {
  console.log(`[${spec.name}]`, ...argsByKeys(ctx.args, spec.logArgKeys))
  const raw = await spec.run(...argsByKeys(ctx.args, spec.runArgKeys)).catch(toolError)
  const previewChars = spec.previewChars ?? 200
  const preview = previewChars === 0 ? raw : raw.slice(0, previewChars)
  console.log(`[${spec.name} result]`, preview)
  const content = raw || spec.emptyFallback || raw
  const emitArgs = spec.emitArgKeys ? pickArgsByKeys(ctx.args, spec.emitArgKeys) : ctx.args
  recordToolResult(ctx.convId, ctx.state, ctx.call, spec.name, emitArgs, content)
  return {}
}

/**
 * Executes one function tool call end-to-end.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for side effects and event flow.
 * @param handlers - Tool handler map.
 * @param call - Function tool call to execute.
 * @returns Tool execution outcome for loop control flow.
 */
export async function executeToolCall(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  handlers: Record<string, ToolHandler>,
  call: FunctionToolCall,
): Promise<ToolExecutionOutcome> {
  const parsed = parseToolArguments(call.function.arguments)
  if (!parsed.ok) {
    const errorText = `error: invalid arguments for ${call.function.name}: ${parsed.error}`
    recordToolResult(convId, state, call, call.function.name, { _parse_error: parsed.error }, errorText)
    return {}
  }

  if ((call.function.name === "wait" || call.function.name === "rest") && latestAssistantContent(state).length === 0) {
    console.warn(
      `[runner] ${call.function.name} called with empty assistant content; allowing tool-only turn (provider emitted no text).`,
    )
  }

  const isWaitTool = call.function.name === "wait" || call.function.name === "wait_then_continue"
  if (!isWaitTool) state.toolInFlight = true

  try {
    const handler = handlers[call.function.name]
    if (!handler) {
      const errorText = `error: unknown tool ${call.function.name}`
      recordToolResult(convId, state, call, call.function.name, { _unknown_tool: call.function.name }, errorText)
      return {}
    }
    return await handler({ convId, state, hooks, call, args: parsed.args })
  } catch (err) {
    const errorText = toolError(err)
    if (!hasToolResponse(state, call)) {
      recordToolResult(convId, state, call, call.function.name, { _handler_error: true }, errorText)
    } else {
      console.warn(`[runner] ${call.function.name} failed after recording tool response: ${errorText}`)
    }
    return {}
  } finally {
    if (!isWaitTool) {
      state.toolInFlight = false
      hooks.flushDeferredEvents()
    }
  }
}
