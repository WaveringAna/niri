import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import type {
  CompletionStreamSink,
  CompletionTurnResult,
  Provider,
  ProviderEndpointConfig,
  ProviderSlot,
  ToolCallAssembly,
} from "./types.js"
import { providerId } from "./openai-provider.js"

/**
 * Anthropic-wire provider.
 *
 * Translates the OpenAI-shaped `CompletionRequest` the rest of the harness
 * speaks into Anthropic's Messages API and converts the streamed response back,
 * so the loop never learns which wire format served a turn. Errors are wrapped
 * as `OpenAI.APIError` for the same reason — the shared classifier in
 * `errors.ts` only has to understand one error type.
 */



function wrapAnthropicError(err: unknown): InstanceType<typeof OpenAI.APIError> {
  if (err instanceof Anthropic.APIError) {
    return new OpenAI.APIError(err.status, err.error, err.message, err.headers ?? new Headers())
  }
  if (err instanceof Error) {
    return new OpenAI.APIError(undefined, { type: "unknown_error" }, err.message, new Headers())
  }
  return new OpenAI.APIError(undefined, { type: "unknown_error" }, String(err), new Headers())
}

// ── message conversion (OpenAI → Anthropic) ─────────────────────────────

type AnthropicMessageParam = Anthropic.MessageParam

type AnthropicContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ToolResultBlockParam
  | Anthropic.ToolUseBlockParam

function convertImageUrl(imageUrl: { url: string; detail?: string }): Anthropic.ImageBlockParam | null {
  const url = imageUrl.url
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    if (match) {
      const mediaType = match[1]
      const data = match[2] ?? ""
      if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/gif" || mediaType === "image/webp") {
        return { type: "image", source: { type: "base64", media_type: mediaType, data } }
      }
    }
  }
  console.warn(`[anthropic] skipping unsupported image URL: ${url.slice(0, 80)}...`)
  return null
}

function extractUserContentBlocks(
  msg: OpenAI.Chat.ChatCompletionMessageParam,
): AnthropicContentBlock[] {
  const content = msg.content
  if (typeof content === "string") {
    return [{ type: "text" as const, text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: "text" as const, text: JSON.stringify(content) }]
  }

  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text" as const, text: part.text })
    } else if (part.type === "image_url") {
      const imageBlock = convertImageUrl(part.image_url)
      if (imageBlock) blocks.push(imageBlock)
    }
  }
  return blocks
}

function extractAssistantContentBlocks(
  msg: OpenAI.Chat.ChatCompletionAssistantMessageParam,
  enableThinking: boolean,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []

  if (enableThinking) {
    const reasoning = (msg as any).reasoning_content
    const thinkingText =
      typeof reasoning === "string" && reasoning.trim().length > 0 ? reasoning : "Thinking..."
    blocks.push({
      type: "thinking" as any,
      thinking: thinkingText,
    } as any)
  }

  if (typeof msg.content === "string" && msg.content) {
    blocks.push({ type: "text" as const, text: msg.content })
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ type: "text" as const, text: part.text })
      }
    }
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.type === "function") {
        let input: Record<string, unknown>
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = {}
        }
        blocks.push({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }
  }

  return blocks
}

function toAnthropicMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  enableThinking: boolean,
): { system?: string | undefined; messages: AnthropicMessageParam[] } {
  const systemParts: string[] = []
  const out: AnthropicMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemParts.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") systemParts.push(part.text)
        }
      }
      continue
    }

    if (msg.role === "user") {
      const blocks = extractUserContentBlocks(msg)
      const last = out[out.length - 1]
      if (last && last.role === "user") {
        const existing = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }]
        last.content = [...existing, ...blocks]
      } else {
        out.push({ role: "user", content: blocks })
      }
      continue
    }

    if (msg.role === "assistant") {
      const blocks = extractAssistantContentBlocks(msg as OpenAI.Chat.ChatCompletionAssistantMessageParam, enableThinking)
      const last = out[out.length - 1]
      if (last && last.role === "assistant") {
        const existing = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }]
        last.content = [...existing, ...blocks]
      } else {
        out.push({ role: "assistant", content: blocks })
      }
      continue
    }

    if (msg.role === "tool") {
      const toolMsg = msg as OpenAI.Chat.ChatCompletionToolMessageParam
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: toolMsg.tool_call_id,
        content: typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content),
      }
      const last = out[out.length - 1]
      if (last && last.role === "user") {
        const existing = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }]
        last.content = [...existing, block]
      } else {
        out.push({ role: "user", content: [block] })
      }
      continue
    }
  }

  return {
    system: systemParts.join("\n\n") || undefined,
    messages: out,
  }
}

// ── tool conversion ─────────────────────────────────────────────────────

function toAnthropicTools(tools: OpenAI.Chat.ChatCompletionTool[]): Anthropic.Tool[] {
  return tools
    .filter((tool): tool is OpenAI.Chat.ChatCompletionTool & { type: "function"; function: { name: string; description?: string; parameters?: unknown } } => tool.type === "function")
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      input_schema: (tool.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
    }))
}

function toAnthropicToolChoice(
  toolChoice: "required" | "auto" | "none",
): Anthropic.ToolChoice | undefined {
  if (toolChoice === "required") return { type: "any" }
  if (toolChoice === "auto") return { type: "auto" }
  return undefined
}

// ── streaming conversion (Anthropic SSE → OpenAI chunks) ────────────────

function makeChunk(partial: Omit<OpenAI.Chat.ChatCompletionChunk.Choice.Delta, "role" | "content" | "tool_calls" | "reasoning_content"> & {
  role?: "assistant"
  content?: string | null
  reasoning_content?: string
  tool_calls?: OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall[]
}): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: "anthropic-chunk",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "anthropic",
    choices: [{ delta: partial, finish_reason: null, index: 0 }],
  }
}

async function* anthropicStreamToOpenAI(
  stream: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>,
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>()
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined

  for await (const event of stream) {
    switch (event.type) {
      case "message_start": {
        const inputTokens = event.message.usage?.input_tokens
        if (inputTokens != null) {
          usage = { prompt_tokens: inputTokens, completion_tokens: 0 }
        }
        yield makeChunk({ role: "assistant" })
        break
      }

      case "content_block_start": {
        const index = event.index
        const block = event.content_block
        if (block.type === "tool_use") {
          toolBuffers.set(index, { id: block.id, name: block.name, arguments: "" })
          yield makeChunk({
            tool_calls: [
              {
                index,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          })
        }
        break
      }

      case "content_block_delta": {
        const index = event.index
        const delta = event.delta
        if (delta.type === "text_delta") {
          yield makeChunk({ content: delta.text })
        } else if (delta.type === "thinking_delta") {
          yield makeChunk({ reasoning_content: delta.thinking })
        } else if (delta.type === "input_json_delta") {
          const tool = toolBuffers.get(index)
          if (tool) {
            tool.arguments += delta.partial_json
            yield makeChunk({
              tool_calls: [
                {
                  index,
                  function: { arguments: delta.partial_json },
                },
              ],
            })
          }
        }
        break
      }

      case "message_delta": {
        const outputTokens = event.usage?.output_tokens
        if (outputTokens != null && usage) {
          usage.completion_tokens = outputTokens
        }
        break
      }

      case "message_stop":
        break

      default:
        break
    }
  }

  if (usage) {
    yield {
      id: "anthropic-usage",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "anthropic",
      choices: [],
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    }
  }
}

// ── stream consumer ─────────────────────────────────────────────────────

async function consumeAnthropicStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  sink: CompletionStreamSink | null,
  enableThinking: boolean,
): Promise<CompletionTurnResult> {
  const startedAt = Date.now()
  const contentParts: string[] = []
  const streamedToolCalls = new Map<number, ToolCallAssembly>()
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
      reasoningParts.push(delta.reasoning_content)
      if (enableThinking && sink) {
        sink.onThinking(delta.reasoning_content)
        emittedThinking = true
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

  const finalToolCalls =
    streamedToolCalls.size > 0
      ? [...streamedToolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, toolCall]) => toolCall)
      : []

  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: "assistant",
    content: contentParts.length > 0 ? contentParts.join("") : null,
    refusal: null,
    ...(finalToolCalls.length > 0 ? { tool_calls: finalToolCalls } : {}),
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

// ── public API ──────────────────────────────────────────────────────────


export type AnthropicProviderDeps = {
  slot: ProviderSlot
  enableThinking: boolean
}

export function createAnthropicProvider(
  config: ProviderEndpointConfig,
  deps: AnthropicProviderDeps,
): Provider {
  const maxTokens = config.maxTokens ?? 8192
  const thinkingBudget = config.thinkingBudget ?? 0
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: {
      "Anthropic-Version": config.apiVersion ?? "2024-10-22",
      ...config.headers,
    },
  })

  return {
    id: providerId(config.baseUrl, config.model),
    kind: "anthropic",
    model: config.model,
    baseUrl: config.baseUrl,
    toolChoice: config.toolChoice,
    config,
    async complete(request, options = {}) {
      const enableThinking = deps.enableThinking && thinkingBudget >= 1024
      const sink = options.sink ?? null
      const { system, messages } = toAnthropicMessages(request.messages, enableThinking)

      const body: Anthropic.MessageCreateParams = {
        model: options.model ?? request.model,
        max_tokens: maxTokens,
        messages,
        ...(system ? { system } : {}),
      }

      if (enableThinking) {
        const budget = Math.min(maxTokens - 1, thinkingBudget)
        if (budget >= 1024) {
          ;(body as unknown as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: budget }
        }
      }

      const toolChoice = options.toolChoice ?? request.tool_choice
      if (request.tools.length > 0 && toolChoice !== "none") {
        body.tools = toAnthropicTools(request.tools)
        let tc = toAnthropicToolChoice(toolChoice)
        // Anthropic rejects tool_choice 'any' while extended thinking is on.
        if (tc && (tc as unknown as { type: string }).type === "any" && enableThinking) {
          console.warn("[anthropic] tool_choice='any' is incompatible with thinking; downgrading to 'auto'")
          tc = { type: "auto" }
        }
        if (tc) body.tool_choice = tc
      }

      try {
        const stream = await client.messages.create({ ...body, stream: true })
        const converted = anthropicStreamToOpenAI(stream)
        const result = await consumeAnthropicStream(converted, sink, enableThinking)
        return { ...result, servedBy: deps.slot }
      } catch (err) {
        throw wrapAnthropicError(err)
      }
    },
  }
}
