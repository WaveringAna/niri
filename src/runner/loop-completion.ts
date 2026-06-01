import OpenAI from "openai"
import { logMessage } from "../db"
import { buildCompletionMessages, rememberRecalledMemoryChunks } from "../memory"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { LoopState } from "./types"
import {
  API_BASE,
  ENABLE_THINKING,
  FALLBACK_BASE,
  FALLBACK_MODEL,
  FALLBACK_TOOL_CHOICE,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL,
  MODEL,
  PRIMARY_TOOL_CHOICE,
  SUMMARY_MODEL,
  TOOLS,
  USE_ANTHROPIC,
  USE_FALLBACK,
  apiErrorDetails,
  client,
  clearPrimaryFailover,
  errorSummary,
  estimatePromptTokens,
  fallbackClient,
  fallbackContextWindow,
  findSummaryMessageIndex,
  isContentFilterError,
  isImageParseError,
  isPromptTooLargeError,
  isQuotaExhaustedError,
  loadAgentSummaryContext,
  primaryFailoverStatus,
  recordPrimaryQuotaFailover,
  retryDelayMs,
  sanitizeMessages,
  scrubImagesFromConversation,
  shouldFallback,
  shouldRetryProvider,
  summaryClient,
  summarizeConversationViaLLM,
} from "./util"
import { createAnthropicCompletion } from "./anthropic"
import { assistantContentText } from "./loop-content"
import type { CompletionRequest, CompletionTurnResult, ToolCallAssembly } from "./loop-shared"

/**
 * Resolves the configured summary client/model pair.
 *
 * @returns Active summary provider config.
 */
export async function configuredSummaryProvider(): Promise<{ client: OpenAI | null; model: string }> {
  if (summaryClient && SUMMARY_MODEL) return { client: summaryClient, model: SUMMARY_MODEL }
  const failover = USE_FALLBACK ? null : await primaryFailoverStatus()
  if (failover?.active) return { client: fallbackClient, model: FALLBACK_MODEL }
  return {
    client: USE_FALLBACK ? fallbackClient : client,
    model: USE_FALLBACK ? FALLBACK_MODEL : MODEL,
  }
}

function logApiError(err: unknown, context: string): void {
  if (!(err instanceof OpenAI.APIError)) return
  console.error(`[api] ${err.status} ${err.message} - ${context}`)
  for (const line of apiErrorDetails(err)) console.error(line)
}

function primaryApiContext(): string {
  const model = USE_ANTHROPIC ? ANTHROPIC_MODEL : MODEL
  const api = USE_ANTHROPIC ? ANTHROPIC_BASE_URL : API_BASE
  return `model=${model} api=${api}`
}

/**
 * Appends an assistant message to state and persists it to conversation logs.
 *
 * @param convId - Active conversation id.
 * @param state - Mutable loop state.
 * @param msg - Assistant message to append.
 */
export function addAssistantMessage(convId: number, state: LoopState, msg: OpenAI.Chat.ChatCompletionMessage): void {
  state.conversation.push(msg)
  logMessage(convId, msg.role, msg.content ?? "", msg.tool_calls ?? undefined)
}

function recordPromptResponse(request: CompletionRequest, result: CompletionTurnResult, promptMetricId: number | null): void {
  recordMetric({
    type: "prompt_response",
    promptMetricId: promptMetricId ?? undefined,
    model: request.model,
    toolChoice: request.tool_choice,
    messages: request.messages,
    response: result.message,
    usage: result.usage,
  })
}

/**
 * Applies token usage from a completion response to loop state counters.
 *
 * @param state Mutable loop state.
 * @param usage Completion usage payload (if provided by the API).
 * @param timing Runner-measured stream timing for throughput display.
 */
export function applyUsage(
  state: LoopState,
  usage: OpenAI.Completions.CompletionUsage | undefined,
  timing: Pick<CompletionTurnResult, "elapsedMs" | "tokensPerSecond"> = {},
): void {
  if (!usage) return
  state.tokenCount += usage.total_tokens
  if (usage.prompt_tokens) state.contextSize = usage.prompt_tokens
  const rate = typeof timing.tokensPerSecond === "number" ? ` ${timing.tokensPerSecond.toFixed(1)} tok/s` : ""
  console.log(`[tokens] +${usage.total_tokens} total=${state.tokenCount}${rate}`)
  emit({
    type: "usage",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    elapsedMs: timing.elapsedMs,
    tokensPerSecond: timing.tokensPerSecond,
  })
  recordMetric({ type: "usage", usage })
}

/**
 * Emits model reasoning text when exposed by the provider.
 *
 * Supports both `reasoning_content` and `<think>...</think>` wrappers.
 *
 * @param msg - Assistant message to inspect for reasoning traces.
 */
export function emitThinking(msg: OpenAI.Chat.ChatCompletionMessage): void {
  const rawMsg = msg as unknown as Record<string, unknown>
  let thinkingText: string | null = null

  if (typeof rawMsg.reasoning_content === "string" && rawMsg.reasoning_content.trim()) {
    thinkingText = rawMsg.reasoning_content.trim()
  } else if (typeof msg.content === "string") {
    const match = msg.content.match(/^<think>([\s\S]*?)<\/think>\s*/i)
    if (match) {
      thinkingText = match[1]!.trim()
      ;(msg as unknown as Record<string, unknown>).content = msg.content.slice(match[0].length)
    }
  }

  if (thinkingText) emit({ type: "thinking", text: thinkingText })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatAbsoluteTime(timeMs: number): string {
  const retryAt = new Date(timeMs)
  const local = retryAt.toLocaleString(undefined, {
    hour12: false,
    timeZoneName: "short",
  })
  return `${local} (${retryAt.toISOString()})`
}

function formatRetryAt(retryAfterMs: number): string {
  return formatAbsoluteTime(Date.now() + retryAfterMs)
}

const PRIMARY_FAILOVER_NOTICE_INTERVAL_MS = 60 * 60 * 1000
let lastPrimaryFailoverNoticeAtMs = 0

function shouldLogPrimaryFailoverNotice(nowMs = Date.now()): boolean {
  if (nowMs - lastPrimaryFailoverNoticeAtMs < PRIMARY_FAILOVER_NOTICE_INTERVAL_MS) return false
  lastPrimaryFailoverNoticeAtMs = nowMs
  return true
}

function apiErrorSearchText(err: { message: string; error?: unknown }): string {
  const parts = [err.message]
  if (err.error !== undefined) {
    try {
      parts.push(JSON.stringify(err.error))
    } catch {
      parts.push(String(err.error))
    }
  }
  return parts.join("\n")
}

function shouldRetryWithAutoToolChoice(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  const text = apiErrorSearchText(err)
  return /no endpoints found that support the provided 'tool_choice' value|does not support this tool_choice/i.test(text)
}

function shouldRetryWithoutReasoningForTools(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  return /function call should not be used with prefix/i.test(apiErrorSearchText(err))
}

function shouldRetryWithReasoningEnabled(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  return /reasoning is mandatory|reasoning cannot be disabled|reasoning is required/i.test(apiErrorSearchText(err))
}

function enableReasoningForRequest(request: CompletionRequest): CompletionRequest {
  const next: CompletionRequest = {
    ...request,
    include_reasoning: true,
    reasoning: { enabled: true, effort: "low" },
  }
  delete next.enable_thinking
  if (next.chat_template_kwargs) {
    const { enable_thinking: _ignored, ...rest } = next.chat_template_kwargs
    next.chat_template_kwargs = Object.keys(rest).length > 0 ? rest : undefined
    if (!next.chat_template_kwargs) delete next.chat_template_kwargs
  }
  return next
}

function toolCompatibleReasoningExtras(
  request?: Pick<CompletionRequest, "provider" | "chat_template_kwargs">,
): Partial<CompletionRequest> {
  return {
    include_reasoning: false,
    reasoning: { enabled: false, exclude: true, effort: "none" },
    provider: { ...request?.provider, require_parameters: true },
  }
}

function prefixModeToolCallExtras(request?: Pick<CompletionRequest, "provider" | "chat_template_kwargs">): Partial<CompletionRequest> {
  return {
    ...toolCompatibleReasoningExtras(request),
    enable_thinking: false,
    chat_template_kwargs: {
      ...request?.chat_template_kwargs,
      enable_thinking: false,
    },
  }
}

function disableReasoningForToolCalls(request: CompletionRequest): CompletionRequest {
  return {
    ...request,
    ...prefixModeToolCallExtras(request),
  }
}

function configuredThinkingRequestExtras(
  request?: Pick<CompletionRequest, "chat_template_kwargs">,
): Partial<CompletionRequest> {
  if (ENABLE_THINKING) return {}
  return {
    include_reasoning: false,
    reasoning: { enabled: false, exclude: true, effort: "none" },
    enable_thinking: false,
    chat_template_kwargs: {
      ...request?.chat_template_kwargs,
      enable_thinking: false,
    },
  }
}

function openRouterToolRequestExtras(baseUrl: string): Partial<CompletionRequest> {
  if (!baseUrl.includes("openrouter.ai")) return {}
  return toolCompatibleReasoningExtras()
}

function shouldRetryWithoutStreamUsage(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  if (err.status !== 400) return false
  return /stream_options|include_usage/i.test(err.message)
}

function coerceReasoningToolArgument(rawValue: string): unknown {
  const value = rawValue.trim()
  if (!value) return ""
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^null$/i.test(value)) return null

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    try {
      return JSON.parse(value)
    } catch {
      // keep raw string fallback
    }
  }

  return value
}

function parseReasoningToolCallBlock(rawBlock: string): ToolCallAssembly | null {
  const functionMatch = rawBlock.match(/<function(?:=|\s+name\s*=\s*["']?)([^>"'\s/]+)["']?\s*>/i)
  if (!functionMatch || functionMatch.index === undefined) return null

  const functionName = functionMatch[1]?.trim()
  if (!functionName) return null

  const functionBodyStart = functionMatch.index + functionMatch[0].length
  const functionBodyEnd = rawBlock.indexOf("</function>", functionBodyStart)
  if (functionBodyEnd < 0) return null

  const functionBody = rawBlock.slice(functionBodyStart, functionBodyEnd)
  const args: Record<string, unknown> = {}

  const parameterRegex = /<parameter(?:=|\s+name\s*=\s*["']?)([^>"'\s/]+)["']?\s*>([\s\S]*?)<\/parameter>/gi
  for (const match of functionBody.matchAll(parameterRegex)) {
    const key = match[1]?.trim()
    if (!key) continue
    args[key] = coerceReasoningToolArgument(match[2] ?? "")
  }

  return {
    id: "",
    type: "function",
    function: {
      name: functionName,
      arguments: JSON.stringify(args),
    },
  }
}

function drainReasoningToolCallBlocks(buffer: string): { blocks: string[]; remainder: string } {
  const blocks: string[] = []
  let remaining = buffer

  while (true) {
    const openMatch = remaining.match(/<tool_call(?:\s[^>]*)?>/i)
    if (!openMatch || openMatch.index === undefined) {
      const partialStart = remaining.lastIndexOf("<tool_call")
      return {
        blocks,
        remainder: partialStart >= 0 ? remaining.slice(partialStart) : "",
      }
    }

    const openStart = openMatch.index
    const openEnd = openStart + openMatch[0].length
    const closeStart = remaining.indexOf("</tool_call>", openEnd)
    if (closeStart < 0) {
      return {
        blocks,
        remainder: remaining.slice(openStart),
      }
    }

    blocks.push(remaining.slice(openEnd, closeStart))
    remaining = remaining.slice(closeStart + "</tool_call>".length)
  }
}

async function consumeCompletionStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): Promise<CompletionTurnResult> {
  const startedAt = Date.now()
  const contentParts: string[] = []
  const streamedToolCalls = new Map<number, ToolCallAssembly>()
  const reasoningToolCalls: ToolCallAssembly[] = []
  let reasoningToolBuffer = ""

  let usage: OpenAI.Completions.CompletionUsage | undefined
  let emittedText = false
  let emittedThinking = false
  const reasoningParts: string[] = []

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage

    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
      reasoning_content?: string
    }

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      if (ENABLE_THINKING) reasoningParts.push(delta.reasoning_content)

      reasoningToolBuffer += delta.reasoning_content
      const { blocks, remainder } = drainReasoningToolCallBlocks(reasoningToolBuffer)
      reasoningToolBuffer = remainder

      for (const block of blocks) {
        const parsedCall = parseReasoningToolCallBlock(block)
        if (!parsedCall) continue
        parsedCall.id = `call_reasoning_${reasoningToolCalls.length}`
        reasoningToolCalls.push(parsedCall)
      }
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (ENABLE_THINKING && !emittedThinking && reasoningParts.length > 0) {
        emit({ type: "thinking", text: reasoningParts.join("") })
        emittedThinking = true
      }
      contentParts.push(delta.content)
      emit({ type: "text", text: delta.content })
      emittedText = true
    }

    if (!Array.isArray(delta.tool_calls)) continue

    for (const partial of delta.tool_calls) {
      const index = partial.index ?? 0
      const existing = streamedToolCalls.get(index) ?? {
        id: partial.id ?? `call_${index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      }

      if (partial.id) existing.id = partial.id
      if (partial.type === "function") existing.type = "function"
      if (partial.function?.name) existing.function.name += partial.function.name
      if (partial.function?.arguments) existing.function.arguments += partial.function.arguments
      streamedToolCalls.set(index, existing)
    }
  }

  if (streamedToolCalls.size === 0) {
    const trailingReasoningCall = parseReasoningToolCallBlock(reasoningToolBuffer)
    if (trailingReasoningCall) {
      trailingReasoningCall.id = `call_reasoning_${reasoningToolCalls.length}`
      reasoningToolCalls.push(trailingReasoningCall)
    }
  }

  const finalToolCalls =
    streamedToolCalls.size > 0
      ? [...streamedToolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, toolCall]) => toolCall)
      : reasoningToolCalls

  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: "assistant",
    content: contentParts.length > 0 ? contentParts.join("") : null,
    refusal: null,
    ...(finalToolCalls.length > 0
      ? {
          tool_calls: finalToolCalls,
        }
      : {}),
  }

  if (reasoningParts.length > 0) {
    ;(message as OpenAI.Chat.ChatCompletionMessage & { reasoning_content?: string }).reasoning_content =
      reasoningParts.join("")
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const tokensPerSecond =
    usage && elapsedMs > 0 ? usage.completion_tokens / (elapsedMs / 1000) : undefined

  return {
    message,
    usage,
    emittedText,
    emittedThinking,
    bufferedThinking: reasoningParts.join(""),
    elapsedMs,
    tokensPerSecond,
  }
}

async function createStreamedCompletion(
  apiClient: OpenAI,
  request: CompletionRequest,
): Promise<CompletionTurnResult> {
  const streamedRequest = {
    ...request,
    stream: true,
    stream_options: { include_usage: true },
  } as const

  const promptMetricId = recordMetric({ type: "prompt", messages: request.messages })

  try {
    const stream = await apiClient.chat.completions.create(streamedRequest)
    const result = await consumeCompletionStream(stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>)
    recordPromptResponse(request, result, promptMetricId)
    return result
  } catch (err) {
    if (shouldRetryWithoutStreamUsage(err)) {
      const stream = await apiClient.chat.completions.create({
        ...request,
        stream: true,
      } as const)
      const result = await consumeCompletionStream(stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>)
      recordPromptResponse(request, result, promptMetricId)
      return result
    }
    throw err
  }
}

async function createFallbackCompletion(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<CompletionTurnResult> {
  const request: CompletionRequest = {
    model: FALLBACK_MODEL,
    messages,
    tools: TOOLS,
    tool_choice: FALLBACK_TOOL_CHOICE,
    ...openRouterToolRequestExtras(FALLBACK_BASE),
    ...configuredThinkingRequestExtras(),
  }

  let currentRequest = request
  let retriedAutoToolChoice = false
  let retriedWithoutReasoning = false
  let retriedWithReasoning = false
  while (true) {
    try {
      return await createStreamedCompletion(fallbackClient, currentRequest)
    } catch (err) {
      if (currentRequest.tool_choice !== "auto" && !retriedAutoToolChoice && shouldRetryWithAutoToolChoice(err)) {
        retriedAutoToolChoice = true
        console.warn(
          `[fallback] provider rejected tool_choice=${currentRequest.tool_choice}; retrying with tool_choice=auto`,
        )
        currentRequest = {
          ...currentRequest,
          tool_choice: "auto",
        }
        continue
      }
      if (!retriedWithoutReasoning && shouldRetryWithoutReasoningForTools(err)) {
        retriedWithoutReasoning = true
        console.warn("[fallback] provider rejected function calling in reasoning/prefix mode; retrying fallback with tool-compatible reasoning disabled")
        currentRequest = disableReasoningForToolCalls(currentRequest)
        continue
      }
      if (!retriedWithReasoning && shouldRetryWithReasoningEnabled(err)) {
        retriedWithReasoning = true
        console.warn(`[fallback] model ${currentRequest.model} requires reasoning; retrying fallback with reasoning enabled`)
        currentRequest = enableReasoningForRequest(currentRequest)
        continue
      }
      throw err
    }
  }
}

async function createPrimaryCompletion(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<CompletionTurnResult> {
  if (USE_ANTHROPIC) {
    return createAnthropicCompletion({
      model: ANTHROPIC_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: PRIMARY_TOOL_CHOICE,
    })
  }

  const request: CompletionRequest = {
    model: MODEL,
    messages,
    tools: TOOLS,
    tool_choice: PRIMARY_TOOL_CHOICE,
    ...openRouterToolRequestExtras(API_BASE),
    ...configuredThinkingRequestExtras(),
  }

  let currentRequest = request
  let retriedAutoToolChoice = false
  let retriedWithoutReasoning = false
  let retriedWithReasoning = false
  while (true) {
    try {
      return await createStreamedCompletion(client!, currentRequest)
    } catch (err) {
      if (currentRequest.tool_choice !== "auto" && !retriedAutoToolChoice && shouldRetryWithAutoToolChoice(err)) {
        retriedAutoToolChoice = true
        console.warn(`[api] provider rejected tool_choice=${currentRequest.tool_choice}; retrying primary with tool_choice=auto`)
        currentRequest = {
          ...currentRequest,
          tool_choice: "auto",
        }
        continue
      }
      if (!retriedWithoutReasoning && shouldRetryWithoutReasoningForTools(err)) {
        retriedWithoutReasoning = true
        console.warn("[api] provider rejected function calling in reasoning/prefix mode; retrying primary with tool-compatible reasoning disabled")
        currentRequest = disableReasoningForToolCalls(currentRequest)
        continue
      }
      if (!retriedWithReasoning && shouldRetryWithReasoningEnabled(err)) {
        retriedWithReasoning = true
        console.warn(`[api] model ${currentRequest.model} requires reasoning; retrying primary with reasoning enabled`)
        currentRequest = enableReasoningForRequest(currentRequest)
        continue
      }
      throw err
    }
  }
}

function logPromptSizeDebug(state: LoopState, err: unknown, label: string): void {
  const messageCount = state.conversation.length
  const roleCounts = state.conversation.reduce<Record<string, number>>((acc, m) => {
    const role = (m as { role?: string }).role ?? "unknown"
    acc[role] = (acc[role] ?? 0) + 1
    return acc
  }, {})
  const estimate = estimatePromptTokens(state.conversation)
  const charLength = JSON.stringify(state.conversation).length
  const summary = err instanceof OpenAI.APIError ? `${err.status} ${err.message}` : errorSummary(err)
  console.warn(
    `[api] ${label}: ${summary} - messages=${messageCount} est_tokens=${estimate} chars=${charLength} roles=${JSON.stringify(roleCounts)} observedPromptTokens=${state.contextSize}`,
  )
}

async function recoverFromPromptTooLarge(state: LoopState, attempt: number): Promise<boolean> {
  const beforeCount = state.conversation.length
  const beforeEstimate = estimatePromptTokens(state.conversation)

  const summaryProvider = await configuredSummaryProvider()
  if (!summaryProvider.client || !summaryProvider.model) {
    console.warn(`[context] recovery: no summary client available; cannot llm-summarize`)
    return false
  }

  console.warn(`[context] recovery: attempting llm summarization via ${summaryProvider.model} (attempt=${attempt + 1})`)
  const agentContext = await loadAgentSummaryContext()
  const summarized = await summarizeConversationViaLLM(state.conversation, summaryProvider.client, summaryProvider.model, {
    agentContext,
  })
  if (!summarized) {
    console.warn(`[context] recovery: llm summarization returned no changes`)
    return false
  }

  const afterEstimate = estimatePromptTokens(summarized)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context] recovery: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping original`)
    return false
  }

  state.conversation = summarized
  state.contextSize = afterEstimate

  const summaryIdx = findSummaryMessageIndex(state.conversation)
  const summary = summaryIdx >= 0 ? (state.conversation[summaryIdx]?.content as string) : undefined

  console.warn(
    `[context] recovery: llm-summarized conversation (${beforeCount} -> ${summarized.length} msgs, ${beforeEstimate} -> ${afterEstimate} tokens)`,
  )

  recordMetric({
    type: "compaction",
    before: beforeEstimate,
    after: afterEstimate,
    method: "force-llm",
    summary,
  })
  return true
}

/**
 * Fetches the next assistant completion, including fallback and backoff behavior.
 *
 * @param state - Mutable loop state containing current conversation/context.
 * @param baseConversation - Optional alternate base conversation for retries.
 * @returns The next chat completion response.
 * @throws If the primary request fails with a non-fallback error condition.
 */
export async function fetchCompletion(
  state: LoopState,
  baseConversation: OpenAI.Chat.ChatCompletionMessageParam[] = state.conversation,
): Promise<CompletionTurnResult> {
  let promptTooLargeAttempts = 0
  let imagesScrubbed = false

  // Both content-filter rejections and image parse/format rejections (e.g.
  // z.ai/GLM code 1210) stick across turns when the offending image lives in
  // the persisted conversation, which crash-loops the runner on restart.
  // Scrub the image parts (replacing them with a placeholder the model sees)
  // and retry so the loop survives instead of aborting.
  const recoverByScrubbingImages = (err: unknown, label: string): boolean => {
    if (imagesScrubbed) return false
    if (!isContentFilterError(err) && !isImageParseError(err)) return false
    const reason = isContentFilterError(err) ? "content-filter rejection" : "image parse/format rejection"
    const scrubbed = scrubImagesFromConversation(state.conversation)
    imagesScrubbed = true
    if (scrubbed > 0) {
      console.warn(
        `[api] ${label} ${reason}; scrubbed ${scrubbed} image attachment(s) from conversation and retrying`,
      )
      return true
    }
    console.warn(`[api] ${label} ${reason} but no images found to scrub`)
    return false
  }

  while (true) {
    if (baseConversation === state.conversation) {
      state.conversation = sanitizeMessages(state.conversation)
      baseConversation = state.conversation
    } else {
      baseConversation = sanitizeMessages(baseConversation)
    }

    // Only run memory recall on the first step of a new turn. Re-running it on
    // every agentic iteration floods context with the same recalled chunks for
    // the same (unchanged) user message.
    const requestContext = state.memoryRecallPending
      ? await buildCompletionMessages(
          baseConversation,
          state.memoryRecallCooldowns,
          state.memoryRecallTurn,
        )
      : { messages: baseConversation, recalledChunkIds: [] as number[] }
    const requestMessages = requestContext.messages

    const primaryFailoverBefore = USE_FALLBACK ? null : await primaryFailoverStatus()
    if (primaryFailoverBefore?.active) {
      if (shouldLogPrimaryFailoverNotice()) {
        console.warn(
          `[api] primary quota cooldown active; using fallback until ${formatAbsoluteTime(primaryFailoverBefore.retryAtMs)} (${Math.ceil(primaryFailoverBefore.remainingMs / 1000)}s remaining)`,
        )
      }

      const fallbackWindow = fallbackContextWindow(requestMessages)
      if (fallbackWindow.nearLimit) {
        console.warn(
          `[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`,
        )
      }

      try {
        const completion = await createFallbackCompletion(requestMessages)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(
          state.memoryRecallCooldowns,
          requestContext.recalledChunkIds,
          state.memoryRecallTurn,
        )
        return completion
      } catch (fallbackErr) {
        if (isPromptTooLargeError(fallbackErr) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, fallbackErr, `fallback rejected prompt during primary quota cooldown (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(fallbackErr, "fallback-primary-quota-cooldown")) continue
        if (shouldRetryProvider(fallbackErr)) {
          const retryAfter = retryDelayMs(fallbackErr)
          console.warn(
            `[fallback] transient failure (${errorSummary(fallbackErr)}); retrying after ${Math.ceil(retryAfter / 1000)}s`,
          )
          console.log(
            `[runner] backing off ${Math.ceil(retryAfter / 1000)}s (until ${formatRetryAt(retryAfter)}) before retrying fallback...`,
          )
          await sleep(retryAfter)
          continue
        }
        logApiError(fallbackErr, `model=${FALLBACK_MODEL} api=${FALLBACK_BASE}`)
        throw fallbackErr
      }
    } else if (primaryFailoverBefore?.retryAtMs) {
      console.warn(`[api] primary quota cooldown expired; probing primary before fallback`)
    }

    if (USE_FALLBACK) {
      const fallbackWindow = fallbackContextWindow(requestMessages)
      if (fallbackWindow.nearLimit) {
        console.warn(
          `[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`,
        )
      }

      try {
        const completion = await createFallbackCompletion(requestMessages)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(
          state.memoryRecallCooldowns,
          requestContext.recalledChunkIds,
          state.memoryRecallTurn,
        )
        return completion
      } catch (fallbackErr) {
        if (isPromptTooLargeError(fallbackErr) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, fallbackErr, `fallback rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(fallbackErr, "fallback")) continue
        if (shouldRetryProvider(fallbackErr)) {
          const retryAfter = retryDelayMs(fallbackErr)
          console.warn(
            `[fallback] transient failure (${errorSummary(fallbackErr)}); retrying after ${Math.ceil(retryAfter / 1000)}s`,
          )
          console.log(
            `[runner] backing off ${Math.ceil(retryAfter / 1000)}s (until ${formatRetryAt(retryAfter)}) before retrying fallback...`,
          )
          await sleep(retryAfter)
          continue
        }
        logApiError(fallbackErr, `model=${FALLBACK_MODEL} api=${FALLBACK_BASE}`)
        throw fallbackErr
      }
    }

    try {
      const completion = await createPrimaryCompletion(requestMessages)
      if (primaryFailoverBefore?.retryAtMs && (await clearPrimaryFailover())) {
        console.warn(`[api] primary probe succeeded; restored primary routing`)
      }
      state.memoryRecallCooldowns = rememberRecalledMemoryChunks(
        state.memoryRecallCooldowns,
        requestContext.recalledChunkIds,
        state.memoryRecallTurn,
      )
      return completion
    } catch (primaryErr) {
      if (isPromptTooLargeError(primaryErr) && promptTooLargeAttempts < 2) {
        logPromptSizeDebug(state, primaryErr, `primary rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
        const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
        promptTooLargeAttempts++
        if (recovered) continue
        logApiError(primaryErr, primaryApiContext())
        throw primaryErr
      }

      if (recoverByScrubbingImages(primaryErr, "primary")) continue

      const primaryQuotaExhausted = isQuotaExhaustedError(primaryErr)

      if (!primaryQuotaExhausted && !shouldFallback(primaryErr)) {
        logApiError(primaryErr, primaryApiContext())
        throw primaryErr
      }

      if (primaryQuotaExhausted) {
        logApiError(primaryErr, `primary quota exhausted; ${primaryApiContext()}`)
        const failover = await recordPrimaryQuotaFailover(primaryErr)
        console.warn(
          `[api] primary quota exhausted; using fallback until ${formatAbsoluteTime(failover.retryAtMs)}`,
        )
      }

      const fallbackWindow = fallbackContextWindow(requestMessages)
      if (!primaryQuotaExhausted && fallbackWindow.skip) {
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

      console.warn(
        primaryQuotaExhausted
          ? `[api] primary quota cooldown set - switching to fallback`
          : `[api] primary down (${errorSummary(primaryErr)}) - switching to fallback`,
      )
      try {
        const completion = await createFallbackCompletion(requestMessages)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(
          state.memoryRecallCooldowns,
          requestContext.recalledChunkIds,
          state.memoryRecallTurn,
        )
        return completion
      } catch (fallbackErr) {
        if (isPromptTooLargeError(fallbackErr) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, fallbackErr, `fallback rejected prompt during failover (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(fallbackErr, "fallback-failover")) continue
        const retryTarget = primaryQuotaExhausted ? "fallback" : "primary"
        console.warn(
          `[api] fallback failed (${errorSummary(fallbackErr)}) after primary failure (${errorSummary(primaryErr)}); retrying ${retryTarget} after backoff`,
        )
        const retryAfter = primaryQuotaExhausted ? retryDelayMs(fallbackErr) : retryDelayMs(primaryErr)
        console.log(
          `[runner] backing off ${Math.ceil(retryAfter / 1000)}s (until ${formatRetryAt(retryAfter)}) before retrying ${retryTarget}...`,
        )
        await sleep(retryAfter)
      }
    }
  }
}

export const __completionTest = {
  consumeCompletionStream,
}
