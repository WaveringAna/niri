import OpenAI from "openai"
import { runCommand, readFile, editFile, readImageForModel } from "../container/index.js"
import {
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
  markDiscordItem,
  scanDiscordChannels,
  setDiscordChannelNote,
  sendDiscordMessage,
} from "../discord/state.js"
import { logMessage } from "../db.js"
import { emit } from "../stream.js"
import type { LoopHooks, LoopState } from "./types.js"
import {
  API_BASE,
  FALLBACK_MODEL,
  FALLBACK_TOOL_CHOICE,
  FALLBACK_TOKEN_NUDGE_THRESHOLD,
  MODEL,
  TOKEN_NUDGE_THRESHOLD,
  TOOLS,
  USE_FALLBACK,
  client,
  errorSummary,
  fallbackClient,
  fallbackContextWindow,
  maybeCompactConversation,
  parseImageDetail,
  parseToolArguments,
  retryDelayMs,
  shouldFallback,
} from "./util.js"

type FunctionToolCall = OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }
type ToolArgs = {
  command?: string
  max_lines?: number
  timeout_ms?: number
  path?: string
  start_line?: number
  end_line?: number
  old_text?: string
  new_text?: string
  note?: string
  detail?: string
  limit?: number
  status?: string
  item_id?: string
  action?: string
  channel_id?: string
  channel_ids?: string[]
  before_message_id?: string
  content?: string
  source_item_id?: string
  reference_message?: string
  reply_mode?: string
  include_unconfigured?: boolean
  [key: string]: unknown
}
type ToolExecutionOutcome = { shouldRest?: boolean; isWait?: boolean }
enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Rest = "rest",
}
type ToolArgKey = keyof ToolArgs
type ArgTuple<K extends readonly ToolArgKey[]> = { [I in keyof K]: ToolArgs[K[I]] }

type ToolExecutionContext = {
  convId: number
  state: LoopState
  hooks: LoopHooks
  call: FunctionToolCall
  args: ToolArgs
}

type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>

function assistantContentText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  let combined = ""
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>

    // Accept common structured content formats:
    // - { type: "text", text: "..." }
    // - { type: "text", text: { value: "..." } }
    // - { text: "..." } from OpenAI-compatible providers
    if (typeof record.text === "string") {
      combined += record.text
      continue
    }
    if (
      record.text &&
      typeof record.text === "object" &&
      "value" in record.text &&
      typeof (record.text as { value?: unknown }).value === "string"
    ) {
      combined += (record.text as { value: string }).value
    }
  }

  return combined.trim()
}

function latestAssistantContent(state: LoopState): string {
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const message = state.conversation[i]
    if (!message || message.role !== "assistant") continue
    return assistantContentText(message.content)
  }
  return ""
}

/**
 * Type guard that narrows a tool call to function-call shape.
 *
 * @param call - Raw tool call from the assistant response.
 * @returns `true` when the call is a function tool call.
 */
function isFunctionToolCall(call: OpenAI.Chat.ChatCompletionMessageToolCall): call is FunctionToolCall {
  return call.type === "function"
}

/**
 * Sleeps for a fixed duration.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that resolves after the timeout.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatRetryAt(retryAfterMs: number): string {
  const retryAt = new Date(Date.now() + retryAfterMs)
  const local = retryAt.toLocaleString(undefined, {
    hour12: false,
    timeZoneName: "short",
  })
  return `${local} (${retryAt.toISOString()})`
}

function shouldRetryFallbackWithAutoToolChoice(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  return /no endpoints found that support the provided 'tool_choice' value/i.test(err.message)
}

async function createFallbackCompletion(state: LoopState): Promise<OpenAI.Chat.ChatCompletion> {
  const request = {
    model: FALLBACK_MODEL,
    messages: state.conversation,
    tools: TOOLS,
    tool_choice: FALLBACK_TOOL_CHOICE,
  } as const

  try {
    return await fallbackClient.chat.completions.create(request)
  } catch (err) {
    if (request.tool_choice !== "auto" && shouldRetryFallbackWithAutoToolChoice(err)) {
      console.warn(
        `[fallback] provider rejected tool_choice=${request.tool_choice}; retrying with tool_choice=auto`,
      )
      return fallbackClient.chat.completions.create({
        ...request,
        tool_choice: "auto",
      })
    }
    throw err
  }
}

/**
 * Appends an assistant message to state and persists it to conversation logs.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param msg - Assistant message to append.
 */
function addAssistantMessage(convId: number, state: LoopState, msg: OpenAI.Chat.ChatCompletionMessage): void {
  state.conversation.push(msg)
  logMessage(convId, msg.role, msg.content ?? "", msg.tool_calls ?? undefined)
}

/**
 * Applies token usage from a completion response to loop state counters.
 *
 * @param state - Mutable loop state.
 * @param usage - Completion usage payload (if provided by the API).
 */
function applyUsage(state: LoopState, usage: OpenAI.Completions.CompletionUsage | undefined): void {
  if (!usage) return
  state.tokenCount += usage.total_tokens
  if (usage.prompt_tokens) state.contextSize = usage.prompt_tokens
  console.log(`[tokens] +${usage.total_tokens} total=${state.tokenCount}`)
}

/**
 * Emits model reasoning text when exposed by the provider.
 *
 * Supports both `reasoning_content` and `<think>...</think>` wrappers.
 *
 * @param msg - Assistant message to inspect for reasoning traces.
 */
function emitThinking(msg: OpenAI.Chat.ChatCompletionMessage): void {
  // Emit thinking / reasoning trace if the model exposes it.
  // Most OpenAI-compatible APIs (ZhiPu, DeepSeek, QWen...) put it in
  // reasoning_content; some models wrap it in <think>...</think> tags.
  const rawMsg = msg as unknown as Record<string, unknown>
  let thinkingText: string | null = null

  if (typeof rawMsg.reasoning_content === "string" && rawMsg.reasoning_content.trim()) {
    thinkingText = rawMsg.reasoning_content.trim()
  } else if (typeof msg.content === "string") {
    const match = msg.content.match(/^<think>([\s\S]*?)<\/think>\s*/i)
    if (match) {
      thinkingText = match[1]!.trim()
      // Strip the <think> block from the visible content before emitting text.
      ;(msg as unknown as Record<string, unknown>).content = msg.content.slice(match[0].length)
    }
  }

  if (thinkingText) emit({ type: "thinking", text: thinkingText })
}

/**
 * Appends a tool-role message and logs it for persistence.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param call - Tool call being satisfied.
 * @param content - Tool result text to persist.
 * @returns The persisted tool content string.
 */
function pushToolMessage(convId: number, state: LoopState, call: FunctionToolCall, content: string): string {
  const toolMsg = {
    role: "tool" as const,
    tool_call_id: call.id,
    content,
  }
  state.conversation.push(toolMsg)
  logMessage(convId, "tool", toolMsg.content, undefined, call.id)
  return toolMsg.content
}

/**
 * Records a tool result message and emits it to stream subscribers.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param call - Tool call being satisfied.
 * @param name - Tool name to emit.
 * @param args - Tool args payload to emit.
 * @param content - Tool result content to persist.
 * @returns The persisted tool result content.
 */
function recordToolResult(
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
function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`
}

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
 * Resolves argument values by key order from a tool argument object.
 *
 * @param args - Parsed tool arguments.
 * @param keys - Keys to project in order.
 * @returns Ordered list of argument values.
 */
function argsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): ArgTuple<K> {
  return keys.map((key) => args[key]) as ArgTuple<K>
}

/**
 * Picks a subset of argument keys into a new object.
 *
 * @param args - Parsed tool arguments.
 * @param keys - Keys to include.
 * @returns Object containing only requested keys.
 */
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
async function runStandardTool<
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
 * Fetches the next assistant completion, including fallback/backoff behavior.
 *
 * @param state - Mutable loop state containing current conversation/context.
 * @returns The next chat completion response.
 * @throws If the primary request fails with a non-fallback error condition.
 */
async function fetchCompletion(state: LoopState): Promise<OpenAI.Chat.ChatCompletion> {
  while (true) {
    if (USE_FALLBACK) {
      const fallbackWindow = fallbackContextWindow(state.conversation)
      if (fallbackWindow.nearLimit) {
        console.warn(
          `[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`,
        )
      }

      return createFallbackCompletion(state)
    }

    try {
      return await client!.chat.completions.create({
        model: MODEL,
        messages: state.conversation,
        tools: TOOLS,
        tool_choice: "required",
      })
    } catch (primaryErr) {
      if (!shouldFallback(primaryErr)) {
        if (primaryErr instanceof OpenAI.APIError) {
          console.error(`[api] ${primaryErr.status} ${primaryErr.message} - model=${MODEL} api=${API_BASE}`)
        }
        throw primaryErr
      }

      const fallbackWindow = fallbackContextWindow(state.conversation)
      if (fallbackWindow.skip) {
        console.warn(
          `[api] primary down (${errorSummary(primaryErr)}) and fallback context estimate ${fallbackWindow.estimate} exceeds hard limit ${fallbackWindow.hardLimit}; retrying primary after backoff`,
        )
        const retryAfter = retryDelayMs(primaryErr)
        console.log(
          `[runner] backing off ${Math.ceil(retryAfter / 1000)}s (until ${formatRetryAt(retryAfter)}) before retrying primary...`,
        )
        await sleep(retryAfter)
        continue
      }

      if (fallbackWindow.nearLimit) {
        console.warn(
          `[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`,
        )
      }

      console.warn(`[api] primary down (${errorSummary(primaryErr)}) - switching to fallback`)
      try {
        return await createFallbackCompletion(state)
      } catch (fallbackErr) {
        console.warn(
          `[api] fallback failed (${errorSummary(fallbackErr)}) after primary failure (${errorSummary(primaryErr)}); retrying primary after backoff`,
        )
        const retryAfter = retryDelayMs(primaryErr)
        console.log(
          `[runner] backing off ${Math.ceil(retryAfter / 1000)}s (until ${formatRetryAt(retryAfter)}) before retrying primary...`,
        )
        await sleep(retryAfter)
      }
    }
  }
}

/**
 * Marks remaining tool calls as skipped after an interrupting incoming event.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param calls - Ordered function tool calls from the current assistant turn.
 * @param startIndex - First unexecuted tool call index.
 * @param source - Event source that caused interruption.
 */
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

/**
 * Injects a pending event immediately after a tool result when available.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for event injection.
 * @param calls - Ordered function tool calls for this assistant turn.
 * @param nextIndex - Index of the next tool call that would have run.
 * @returns `true` when interruption occurred and remaining calls were skipped.
 */
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
 * Builds the function-tool handler table for this loop.
 *
 * @returns Tool-name keyed async handler map.
 */
function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    wait: async ({ convId, state, hooks, call, args }) => {
      recordToolResult(convId, state, call, "wait", args, "Waiting for next event.")
      console.log("[runner] niri is waiting for next event...")
      const incoming = await hooks.waitForEvent()
      hooks.injectIncomingEvent(convId, incoming)
      return { isWait: true }
    },

    rest: async ({ convId, state, hooks, call, args }) => {
      if (args.note) console.log("[runner] rest note:", args.note)
      recordToolResult(convId, state, call, "rest", args, "Goodnight.")
      await hooks.clearSession()
      return { shouldRest: true }
    },

    shell: (ctx) =>
      runStandardTool(ctx, {
        name: "shell",
        logArgKeys: ["command", "timeout_ms"] as const,
        runArgKeys: ["command", "max_lines", "timeout_ms"] as const,
        run: (command, max_lines, timeout_ms) =>
          runCommand(command as string, max_lines as number | undefined, timeout_ms as number | undefined),
        emptyFallback: "(no output)",
      }),

    read_file: (ctx) =>
      runStandardTool(ctx, {
        name: "read_file",
        logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        runArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        run: (path, start_line, end_line, timeout_ms) =>
          readFile(path as string, start_line as number | undefined, end_line as number | undefined, timeout_ms as number | undefined),
        emptyFallback: "(empty file)",
      }),

    edit_file: (ctx) =>
      runStandardTool(ctx, {
        name: "edit_file",
        logArgKeys: ["path", "timeout_ms"] as const,
        runArgKeys: ["path", "old_text", "new_text", "timeout_ms"] as const,
        run: async (path, old_text, new_text, timeout_ms) => {
          const editResult = await editFile(
            path as string,
            old_text as string,
            new_text as string,
            timeout_ms as number | undefined,
          )
          return editResult.ok ? editResult.message : `error: ${editResult.message}`
        },
        emitArgKeys: ["path"] as const,
        previewChars: 0,
      }),

    image_tool: async ({ convId, state, call, args }) => {
      console.log("[image_tool]", args.path, args.timeout_ms)
      let result: string

      try {
        const detail = parseImageDetail(args.detail)
        const image = await readImageForModel(args.path as string, args.timeout_ms as number | undefined)
        const note =
          typeof args.note === "string" && args.note.trim()
            ? args.note.trim()
            : `Please inspect this image: ${image.path}`

        result = pushToolMessage(convId, state, call, `attached ${image.path} (${image.mime}, ${image.bytes} bytes)`)

        const imageMessage: OpenAI.Chat.ChatCompletionUserMessageParam = {
          role: "user",
          content: [
            { type: "text", text: note },
            { type: "image_url", image_url: { url: image.dataUrl, detail } },
          ],
        }
        state.conversation.push(imageMessage)
        logMessage(convId, "user", `[image_tool] ${note}\npath=${image.path}\ndetail=${detail}`)
      } catch (err) {
        result = recordToolResult(convId, state, call, "image_tool", { path: args.path, detail: args.detail }, toolError(err))
        return {}
      }

      emit({ type: "tool", name: "image_tool", args: { path: args.path, detail: args.detail }, result })
      return {}
    },

    discord_scan: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_scan",
        logArgKeys: ["limit", "before_message_id"] as const,
        runArgKeys: ["limit", "channel_ids", "before_message_id"] as const,
        run: async (limit, channel_ids, before_message_id) =>
          JSON.stringify(
            await scanDiscordChannels({
              limit: limit as number | undefined,
              channelIds: channel_ids as string[] | string | undefined,
              beforeMessageId: before_message_id as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_inbox: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_inbox",
        logArgKeys: ["limit", "status"] as const,
        runArgKeys: ["limit", "status"] as const,
        run: async (limit, status) =>
          JSON.stringify(
            listDiscordInbox(limit as number | undefined, status as string | string[] | undefined),
            null,
            2,
          ),
      }),

    discord_backread: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_backread",
        logArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        runArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        run: async (channel_id, limit, before_message_id) =>
          JSON.stringify(
            listDiscordBackread(
              channel_id as string,
              limit as number | undefined,
              before_message_id as string | undefined,
            ),
            null,
            2,
          ),
      }),

    discord_mark: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_mark",
        logArgKeys: ["item_id", "status", "action"] as const,
        runArgKeys: ["item_id", "status", "note", "action"] as const,
        run: async (item_id, status, note, action) => {
          markDiscordItem(
            item_id as string,
            status as "pending" | "seen" | "acted" | "ignored",
            (note as string | undefined) ?? "",
            (action as "none" | "replied" | "messaged" | "dismissed" | "noted" | undefined) ?? "none",
          )
          return JSON.stringify(
            {
              ok: true,
              item_id,
              status,
              action: action ?? "none",
              note: note ?? "",
            },
            null,
            2,
          )
        },
      }),

    discord_send: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["channel_id", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "source_item_id", "reply_mode", "reference_message"] as const,
        run: async (channel_id, content, source_item_id, reply_mode, reference_message) =>
          JSON.stringify(
            await sendDiscordMessage({
              channelId: channel_id as string,
              content: content as string,
              sourceItemId: source_item_id as string | undefined,
              replyMode: reply_mode as string | undefined,
              referenceMessage: reference_message as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_channels: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channels",
        logArgKeys: ["include_unconfigured"] as const,
        runArgKeys: ["include_unconfigured"] as const,
        run: async (include_unconfigured) =>
          JSON.stringify(listDiscordChannels(include_unconfigured !== false), null, 2),
      }),

    discord_channel_note: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channel_note",
        logArgKeys: ["channel_id"] as const,
        runArgKeys: ["channel_id", "note"] as const,
        run: async (channel_id, note) =>
          JSON.stringify(setDiscordChannelNote(channel_id as string, (note as string | undefined) ?? ""), null, 2),
      }),
  }
}

/**
 * Executes a single function tool call end-to-end.
 *
 * Parses arguments, dispatches to the tool handler, and manages in-flight state.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for side effects and event flow.
 * @param handlers - Tool handler map.
 * @param call - Function tool call to execute.
 * @returns Tool execution outcome for loop control flow.
 */
async function executeToolCall(
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
    // Some providers emit tool-only assistant turns with empty `content`.
    // Don't block wait/rest in that case; log it for debugging instead.
    console.warn(
      `[runner] ${call.function.name} called with empty assistant content; allowing tool-only turn (provider emitted no text).`,
    )
  }

  const isWaitTool = call.function.name === "wait"
  if (!isWaitTool) state.toolInFlight = true

  try {
    const handler = handlers[call.function.name]
    if (!handler) return {}
    return await handler({ convId, state, hooks, call, args: parsed.args })
  } finally {
    if (!isWaitTool) {
      state.toolInFlight = false
      hooks.flushDeferredEvents()
    }
  }
}

/**
 * Processes all function tool calls requested in one assistant turn.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for side effects and event flow.
 * @param calls - Function tool calls to execute in order.
 * @returns Cycle outcome indicating whether to continue or rest.
 */
async function processToolCalls(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
): Promise<CycleOutcome> {
  const handlers = buildToolHandlers()

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    const outcome = await executeToolCall(convId, state, hooks, handlers, call)

    if (outcome.shouldRest) return CycleOutcome.Rest
    if (outcome.isWait) continue

    const interrupted = maybeInterruptAfterTool(convId, state, hooks, calls, i + 1)
    if (interrupted) return CycleOutcome.ToolsDone
  }

  return CycleOutcome.ToolsDone
}

/**
 * Processes a single assistant turn: completion, reasoning/text emission, tools.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param hooks - Loop hooks for side effects and event flow.
 * @returns Cycle outcome indicating whether tools ran, none ran, or rest occurred.
 * @throws Propagates non-fallback completion errors from `fetchCompletion`.
 */
async function processAssistantTurn(convId: number, state: LoopState, hooks: LoopHooks): Promise<CycleOutcome> {
  const response = await fetchCompletion(state)
  applyUsage(state, response.usage)

  const msg = response.choices[0].message
  addAssistantMessage(convId, state, msg)
  emitThinking(msg)

  // With tool_choice: "required" this shouldn't happen but handle gracefully anyway.
  const functionCalls = (msg.tool_calls ?? []).filter(isFunctionToolCall)
  if (msg.content) emit({ type: "text", text: msg.content })
  if (functionCalls.length === 0) return CycleOutcome.NoTools

  return processToolCalls(convId, state, hooks, functionCalls)
}

/**
 * Appends a system nudge when context token usage passes threshold.
 *
 * @param state - Mutable loop state.
 */
function applyContextNudge(state: LoopState): void {
  const tokenNudgeThreshold = USE_FALLBACK ? FALLBACK_TOKEN_NUDGE_THRESHOLD : TOKEN_NUDGE_THRESHOLD
  const contextProvider = USE_FALLBACK ? "fallback" : "primary"

  if (state.contextSize >= tokenNudgeThreshold) {
    state.conversation.push({
      role: "user",
      content: `[system] context at ~${Math.round(state.contextSize / 1000)}k tokens (${contextProvider}). Consider wrapping up soon to stay within the context limit.`,
    })
  }
}

/**
 * Compacts older context into a rolling summary when prompt size is too large.
 *
 * @param state - Mutable loop state.
 * @param phase - Log label for pre/post-turn compaction runs.
 * @returns `true` when conversation messages were compacted.
 */
function applyRollingCompaction(state: LoopState, phase: "pre-turn" | "post-turn"): boolean {
  const result = maybeCompactConversation(state.conversation, state.contextSize)
  if (!result.compacted) return false

  state.conversation = result.messages
  state.contextSize = result.estimateAfter

  console.log(
    `[context] ${phase} compacted ${result.messagesRemoved} messages across ${result.chunks} chunks (${result.estimateBefore} -> ${result.estimateAfter})`,
  )
  return true
}

/**
 * Executes the main assistant/tool loop for an active conversation.
 *
 * The loop repeatedly:
 * 1) fetches a model turn,
 * 2) executes requested tools,
 * 3) persists session state,
 * until a rest action terminates the cycle.
 *
 * @param convId - Active conversation id used for persistence/logging.
 * @param state - Mutable loop state for conversation, tokens, and pending events.
 * @param hooks - Host-provided lifecycle and event hooks.
 * @returns A promise that resolves when the loop exits.
 */
export async function runLoop(convId: number, state: LoopState, hooks: LoopHooks): Promise<void> {
  while (true) {
    const preCompacted = applyRollingCompaction(state, "pre-turn")
    if (preCompacted) await hooks.saveSession()

    const outcome = await processAssistantTurn(convId, state, hooks)
    if (outcome === CycleOutcome.Rest) break

    applyRollingCompaction(state, "post-turn")
    if (outcome !== CycleOutcome.NoTools) {
      applyContextNudge(state)
    }

    await hooks.saveSession()
  }
}
