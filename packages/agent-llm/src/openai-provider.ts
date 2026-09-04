import OpenAI from "openai"
import type {
  CompletionRequest,
  CompletionStreamSink,
  CompletionTurnResult,
  Provider,
  ProviderEndpointConfig,
  ProviderSlot,
  ToolCallAssembly,
} from "./types.js"

/**
 * OpenAI-wire provider.
 *
 * Covers official OpenAI and every compatible gateway (OpenRouter, LM Studio,
 * vLLM, DeepSeek, Together). Provider quirks switch on the endpoint config
 * rather than module-level env, which is what lets two differently-configured
 * providers coexist in one process.
 */

function enableReasoningForRequest(request: CompletionRequest): CompletionRequest {
  const next: CompletionRequest = {
    ...request,
    include_reasoning: true,
    reasoning: { enabled: true, effort: "low" },
  }
  delete next.enable_thinking
  if (next.chat_template_kwargs) {
    const { enable_thinking: _ignored, ...rest } = next.chat_template_kwargs
    if (Object.keys(rest).length > 0) next.chat_template_kwargs = rest
    else delete next.chat_template_kwargs
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
  request: Pick<CompletionRequest, "chat_template_kwargs"> | undefined,
  enableThinking: boolean,
): Partial<CompletionRequest> {
  if (enableThinking) return {}
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
  sink: CompletionStreamSink | null,
  enableThinking: boolean,
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
      if (enableThinking) {
        reasoningParts.push(delta.reasoning_content)
        if (sink) {
          sink.onThinking(delta.reasoning_content)
          emittedThinking = true
        }
      }

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
      contentParts.push(delta.content)
      if (sink) {
        sink.onText(delta.content)
        emittedText = true
      }
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
    ...(usage ? { usage } : {}),
    emittedText,
    emittedThinking,
    bufferedThinking: reasoningParts.join(""),
    elapsedMs,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  }
}

async function createStreamedCompletion(
  apiClient: OpenAI,
  request: CompletionRequest,
  sink: CompletionStreamSink | null,
  enableThinking: boolean,
): Promise<CompletionTurnResult> {
  const streamedRequest = {
    ...request,
    stream: true,
    stream_options: { include_usage: true },
  } as const

  try {
    const stream = await apiClient.chat.completions.create(streamedRequest)
    return await consumeCompletionStream(stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>, sink, enableThinking)
  } catch (err) {
    // Some gateways reject stream_options.include_usage. Retry without it and
    // accept missing usage numbers rather than failing the whole turn.
    if (shouldRetryWithoutStreamUsage(err)) {
      const stream = await apiClient.chat.completions.create({ ...request, stream: true } as const)
      return await consumeCompletionStream(stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>, sink, enableThinking)
    }
    throw err
  }
}

/** Stable circuit-breaker key. Preserves the old `${baseURL}\n${model}` form. */
export function providerId(baseUrl: string, model: string): string {
  return `${baseUrl}\n${model}`
}

export type OpenAIProviderDeps = {
  /** Used to derive a prompt cache key when the endpoint accepts one. */
  agentId: string
  slot: ProviderSlot
  enableThinking: boolean
}

export function createOpenAIProvider(config: ProviderEndpointConfig, deps: OpenAIProviderDeps): Provider {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.headers ? { defaultHeaders: config.headers } : {}),
  })

  return {
    id: providerId(config.baseUrl, config.model),
    kind: "openai",
    model: config.model,
    baseUrl: config.baseUrl,
    toolChoice: config.toolChoice,
    config,
    async complete(request, options = {}) {
      const merged: CompletionRequest = {
        ...request,
        model: options.model ?? request.model,
        tool_choice: options.toolChoice ?? request.tool_choice,
        ...(config.supportsPromptCacheKey
          ? { prompt_cache_key: config.promptCacheKey || `${deps.agentId}:${deps.slot}` }
          : {}),
        ...configuredThinkingRequestExtras(request, deps.enableThinking),
        // OpenRouter interleaves <tool_call> blocks into the reasoning channel
        // unless reasoning is explicitly disabled for tool-bearing requests.
        ...(request.tools.length > 0 ? openRouterToolRequestExtras(config.baseUrl) : {}),
      }
      const result = await createStreamedCompletion(client, merged, options.sink ?? null, deps.enableThinking)
      return { ...result, servedBy: deps.slot }
    },
  }
}

export const __openAIProviderTest = {
  parseReasoningToolCallBlock,
  drainReasoningToolCallBlocks,
  coerceReasoningToolArgument,
  shouldRetryWithoutStreamUsage,
  consumeCompletionStream,
  enableReasoningForRequest,
  disableReasoningForToolCalls,
}
