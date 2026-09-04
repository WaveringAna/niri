import type OpenAI from "openai"
import type { Message } from "@mira/agent-context"
import type { CompletionStreamSink } from "@mira/agent-llm"
import type {
  AgentInput,
  AgentRuntime,
  LoopConfig,
  LoopHooks,
  LoopState,
  RunLoopExit,
  ToolHandler,
  TurnPolicyContext,
} from "./types.js"
import { defaultLoopConfig } from "./types.js"
import { executeToolCall, pushToolMessage, resolveTools } from "./tools.js"

/**
 * The agent turn loop.
 *
 * Ported from `@niri/runtime`'s `runner/loop.ts`, with the Discord-specific
 * `applyDiscordSendNudge` lifted out into a {@link TurnPolicy} and compaction
 * delegated to `@mira/agent-context`. What remains is genuinely generic: run a
 * turn, dispatch its tools, handle interruption, compact when large, wait.
 */

enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Rest = "rest",
}

function isFunctionToolCall(
  call: OpenAI.Chat.ChatCompletionMessageToolCall,
): call is OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" } {
  return call.type === "function"
}

function assistantContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("")
}

/** Bridges streamed completion output onto the runtime's event sink. */
function streamSink(runtime: AgentRuntime): CompletionStreamSink {
  return {
    onText: (text) => runtime.events.emit({ type: "text", text }),
    onThinking: (text) => runtime.events.emit({ type: "thinking", text }),
  }
}

function applyUsage(
  runtime: AgentRuntime,
  state: LoopState,
  usage: OpenAI.Completions.CompletionUsage | undefined,
  tokensPerSecond?: number,
): void {
  if (!usage) return
  state.tokenCount += usage.total_tokens
  // The model-reported prompt size is the only trustworthy context measure; a
  // char-based estimate inflates the tool schema several-fold.
  if (usage.prompt_tokens) state.contextSize = usage.prompt_tokens
  runtime.events.emit({
    type: "usage",
    tokenCount: state.tokenCount,
    contextSize: state.contextSize,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  })
}

async function runCompletion(
  runtime: AgentRuntime,
  state: LoopState,
  tools: OpenAI.Chat.ChatCompletionTool[],
): Promise<{ message: OpenAI.Chat.ChatCompletionMessage; emittedText: boolean }> {
  const resolved = await runtime.providers.resolvePrimary()
  if (!resolved) throw new Error("no model provider is configured for this agent")

  const result = await resolved.provider.complete(
    {
      model: resolved.provider.model,
      messages: state.conversation as OpenAI.Chat.ChatCompletionMessageParam[],
      tools,
      tool_choice: resolved.provider.toolChoice,
    },
    { sink: streamSink(runtime) },
  )

  applyUsage(runtime, state, result.usage, result.tokensPerSecond)
  if (!result.emittedThinking && result.bufferedThinking) {
    runtime.events.emit({ type: "thinking", text: result.bufferedThinking })
  }
  return { message: result.message, emittedText: result.emittedText }
}

async function compact(
  runtime: AgentRuntime,
  state: LoopState,
  phase: string,
  recollect: () => Promise<string | null>,
): Promise<boolean> {
  const outcome = await runtime.compactor.maybeCompact({
    messages: state.conversation,
    observedPromptTokens: state.contextSize,
    phase,
    grounding: await runtime.summaryGrounding(),
    directRecollection: recollect,
  })
  if (!outcome.applied) return false

  state.conversation = outcome.messages
  state.contextSize = outcome.afterTokens
  runtime.metrics.record({
    type: "compaction",
    before: outcome.beforeTokens,
    after: outcome.afterTokens,
    method: outcome.method,
    ...(outcome.summaryText ? { summary: outcome.summaryText } : {}),
  })
  return true
}

async function processToolCalls(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  handlers: Record<string, ToolHandler>,
  allowed: Set<string>,
  calls: ReadonlyArray<OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }>,
): Promise<boolean> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    if (!allowed.has(call.function.name)) {
      const result = pushToolMessage(
        runtime, convId, state, call,
        `error: ${call.function.name} is not available for this agent right now`,
      )
      runtime.events.emit({ type: "tool", name: call.function.name, args: {}, result })
      continue
    }

    const outcome = await executeToolCall(runtime, convId, state, handlers, call, hooks.flushDeferredEvents)
    if (outcome.shouldRest) return true

    // An event that arrived mid-turn preempts the remaining calls, so the agent
    // answers the new input rather than finishing stale work first.
    if (state.pendingInputs.length > 0) {
      const incoming = state.pendingInputs.shift()!
      hooks.injectIncomingEvent(convId, incoming)
      for (const pending of calls.slice(i + 1)) {
        const skipped = pushToolMessage(
          runtime, convId, state, pending,
          `skipped: interrupted by incoming ${incoming.source} event.`,
        )
        runtime.events.emit({ type: "tool", name: pending.function.name, args: { _skipped: true }, result: skipped })
      }
      return false
    }
  }
  return false
}

async function processAssistantTurn(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
): Promise<CycleOutcome> {
  const { definitions, handlers } = resolveTools(runtime.modules, {
    identity: runtime.identity,
    runtime,
  })
  const allowed = new Set(definitions.map((tool) => tool.function.name))

  const { message, emittedText } = await runCompletion(
    runtime, state, definitions as OpenAI.Chat.ChatCompletionTool[],
  )

  state.conversation.push(message as Message)
  // Only function calls are transcribable; the custom-tool variant carries no
  // `function` payload and nothing in this harness emits one.
  const functionCalls = (message.tool_calls ?? []).filter(isFunctionToolCall)
  runtime.transcript.logMessage(
    convId, message.role, message.content ?? "",
    functionCalls.length > 0 ? functionCalls : undefined,
  )

  if (!emittedText && message.content) runtime.events.emit({ type: "text", text: message.content })

  if (functionCalls.length === 0) return CycleOutcome.NoTools

  const shouldRest = await processToolCalls(
    runtime, convId, state, hooks, handlers, allowed, functionCalls,
  )
  return shouldRest ? CycleOutcome.Rest : CycleOutcome.ToolsDone
}

async function waitForImplicitContinuation(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  config: LoopConfig,
): Promise<void> {
  const incoming = await hooks.waitForEventWithTimeout(config.implicitContinuationMs)
  if (incoming) {
    hooks.injectIncomingEvent(convId, incoming)
    return
  }
  if (hooks.shouldShutdown()) return
  const minutes = Math.round(config.implicitContinuationMs / 60_000)
  const continuation =
    `[system] the inferred ${minutes}-minute wait elapsed with no incoming event. ` +
    "continue if useful, or answer without a tool again to wait another interval."
  state.conversation.push({ role: "user", content: continuation })
  runtime.events.emit({ type: "text", text: continuation })
  await hooks.saveSession()
}

/**
 * Runs until the agent rests or shutdown is requested.
 *
 * @returns `"rest"` — the only way this loop exits normally.
 */
export async function runLoop(
  runtime: AgentRuntime,
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  config: LoopConfig = defaultLoopConfig,
): Promise<RunLoopExit> {
  const recollect = async (): Promise<string | null> => null

  while (true) {
    if (await compact(runtime, state, "pre-turn", recollect)) await hooks.saveSession()

    const turnStart = state.conversation.length

    for (const policy of runtime.policies) {
      await policy.onTurnStart?.({ convId, state, runtime, turnMessages: [], calledTools: false })
    }

    state.turnInFlight = true
    let outcome: CycleOutcome
    try {
      outcome = await processAssistantTurn(runtime, convId, state, hooks)
    } finally {
      state.turnInFlight = false
    }
    const turnMessages = state.conversation.slice(turnStart)

    // Policies may inject a corrective message and re-run the turn immediately.
    // This is where Niri's "you replied but never called discord_send" nudge
    // lives now, instead of inside the loop.
    let nudged = false
    if (outcome !== CycleOutcome.Rest) {
      const policyCtx: TurnPolicyContext = {
        convId,
        state,
        runtime,
        turnMessages,
        calledTools: outcome === CycleOutcome.ToolsDone,
      }
      for (const policy of runtime.policies) {
        const nudge = await policy.onTurnEnd?.(policyCtx)
        if (!nudge) continue
        console.warn(`[loop] policy "${policy.name}" nudged the agent`)
        state.conversation.push({ role: "user", content: nudge })
        nudged = true
      }
    }

    if (outcome === CycleOutcome.Rest) return "rest"

    if (hooks.shouldShutdown()) {
      await hooks.saveShutdownSnapshot()
      hooks.resolveShutdown()
      return "rest"
    }

    if (outcome === CycleOutcome.NoTools) {
      if (nudged) continue
      await hooks.saveSession()
      await waitForImplicitContinuation(runtime, convId, state, hooks, config)
      if (hooks.shouldShutdown()) {
        await hooks.saveShutdownSnapshot()
        hooks.resolveShutdown()
        return "rest"
      }
      continue
    }

    await compact(runtime, state, "post-turn", recollect)
    await hooks.saveSession()
  }
}

export function createLoopState(pendingInputs: AgentInput[] = []): LoopState {
  return {
    conversation: [],
    pendingInputs,
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    shutdownRequested: false,
    turnInFlight: false,
    extras: new Map(),
  }
}

export const __loopTest = { assistantContentText, isFunctionToolCall }
