import { emit } from "../stream"
import { buildToolHandlers } from "./loop-tool-registry"
import { executeToolCall, pushToolMessage } from "./loop-tool-runtime"
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

/**
 * Processes all function tool calls requested in one assistant turn.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for side effects and event flow.
 * @param calls - Function tool calls to execute in order.
 * @returns `true` when a `rest` tool call ended the loop, otherwise `false`.
 */
export async function processToolCalls(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
): Promise<boolean> {
  const handlers = buildToolHandlers()

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    const outcome = await executeToolCall(convId, state, hooks, handlers, call)

    if (outcome.shouldRest) return true
    if (outcome.isWait) continue

    const interrupted = maybeInterruptAfterTool(convId, state, hooks, calls, i + 1)
    if (interrupted) return false
  }

  return false
}
