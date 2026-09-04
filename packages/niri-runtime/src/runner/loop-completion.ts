import OpenAI from "openai"
import {
  completeWithResilience,
  createProviderSet,
  resolveProviderConfig,
  type ProviderSet,
} from "@mira/agent-llm"
import type { ToolDefinition } from "@mira/harness-core"
import { AGENT_ID } from "../agent-config"
import { logMessage } from "../db"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { LoopState } from "./types"
import {
  ENABLE_THINKING,
  FALLBACK_MODEL,
  COMPACTION_RECOLLECTION_PROMPT,
  COMPACTION_RECOLLECTION_TURN_INSTRUCTION,
  MODEL,
  SUMMARY_MODEL,
  USE_FALLBACK,
  client,
  errorSummary,
  fallbackClient,
  primaryFailoverStatus,
  sanitizeMessages,
  summaryClient,
  summaryProviderCircuitStatus,
} from "./util"
import { contextArchive } from "./archive"
import type { CompletionRequest, CompletionTurnResult, ToolCallAssembly } from "./loop-shared"

function isPathologicalCompactionRecollection(content: string): boolean {
  if (content.length > 20_000) return true
  const repeatedLines = new Map<string, number>()
  for (const line of content.split("\n").map((item) => item.trim()).filter((item) => item.length >= 12)) {
    repeatedLines.set(line, (repeatedLines.get(line) ?? 0) + 1)
  }
  return [...repeatedLines.values()].some((count) => count >= 6)
}

/**
 * Resolves the configured summary client/model pair.
 *
 * @returns Active summary provider config.
 */
let loggedSummaryCircuit = ""

export async function configuredSummaryProvider(): Promise<{ client: OpenAI | null; model: string }> {
  let provider: { client: OpenAI | null; model: string }
  if (summaryClient && SUMMARY_MODEL) {
    provider = { client: summaryClient, model: SUMMARY_MODEL }
  } else {
    const failover = USE_FALLBACK ? null : await primaryFailoverStatus()
    provider = failover?.active
      ? { client: fallbackClient, model: FALLBACK_MODEL }
      : {
          client: USE_FALLBACK ? fallbackClient : client,
          model: USE_FALLBACK ? FALLBACK_MODEL : MODEL,
        }
  }

  if (!provider.client || !provider.model) return provider
  const circuit = summaryProviderCircuitStatus(provider.client, provider.model)
  if (!circuit.open) {
    loggedSummaryCircuit = ""
    return provider
  }

  const disabledFor = circuit.permanent
    ? "for this process"
    : `until ${new Date(circuit.disabledUntil ?? Date.now()).toISOString()}`
  const logKey = `${provider.model}\n${disabledFor}\n${circuit.reason ?? ""}`
  if (loggedSummaryCircuit !== logKey) {
    console.warn(
      `[context agent=${AGENT_ID}] summary provider circuit open ${disabledFor}: model=${provider.model} reason=${circuit.reason ?? "unknown"}`,
    )
    loggedSummaryCircuit = logKey
  }
  return { client: null, model: provider.model }
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
  options: { emitEvent?: boolean } = {},
): void {
  if (!usage) return
  state.tokenCount += usage.total_tokens
  if (usage.prompt_tokens) state.contextSize = usage.prompt_tokens
  const rate = typeof timing.tokensPerSecond === "number" ? ` ${timing.tokensPerSecond.toFixed(1)} tok/s` : ""
  const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens
  const cache = [
    typeof cachedPromptTokens === "number" ? `cached=${cachedPromptTokens}` : null,
    typeof cacheWriteTokens === "number" ? `cache_write=${cacheWriteTokens}` : null,
  ].filter(Boolean).join(" ")
  console.log(
    `[tokens] +${usage.total_tokens} total=${state.tokenCount} input=${usage.prompt_tokens} output=${usage.completion_tokens}${cache ? ` ${cache}` : ""}${rate}`,
  )
  if (options.emitEvent !== false) {
    emit({
      type: "usage",
      promptTokens: usage.prompt_tokens,
      cachedPromptTokens,
      cacheWriteTokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      elapsedMs: timing.elapsedMs,
      tokensPerSecond: timing.tokensPerSecond,
    })
  }
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





const CONTENT_FILTER_REDACTED_BODY =
  "[message hidden from this model turn after the provider rejected it for sensitive content]"
const CONTENT_FILTER_NOTICE =
  `[system] hey, whatever someone sent you got blocked by z.ai, possibly because it is asking something """sensitive""" to the government of yknow. let the person know if they need to. if its obvious that theyre doing this to mess with you, ignore them`


function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

function redactedIncomingText(content: string): string {
  const blocks = content.split(/\n\s*\n/g)
  if (blocks.length <= 1) return CONTENT_FILTER_REDACTED_BODY

  const headBlocks = /^\[incoming\s+—\s+discord\]/i.test(blocks[0] ?? "") && blocks.length >= 2
    ? blocks.slice(0, 2)
    : blocks.slice(0, 1)

  return [...headBlocks, CONTENT_FILTER_REDACTED_BODY].join("\n\n")
}

function quarantineLatestIncomingForContentFilter(state: LoopState): { redacted: boolean; index: number | null } {
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const message = state.conversation[i]
    if (!message || message.role !== "user") continue

    const raw = contentText(message.content)
    if (!raw.trim()) continue
    if (/^\[system\]/i.test(raw.trim())) continue
    if (/^\[memory recall/i.test(raw.trim())) continue
    if (raw.includes(CONTENT_FILTER_REDACTED_BODY) || raw.includes(CONTENT_FILTER_NOTICE)) continue

    ;(message as { content: unknown }).content = redactedIncomingText(raw)
    state.conversation.push({ role: "user", content: CONTENT_FILTER_NOTICE })
    state.memoryRecallPending = false
    return { redacted: true, index: i }
  }

  state.conversation.push({ role: "user", content: CONTENT_FILTER_NOTICE })
  state.memoryRecallPending = false
  return { redacted: false, index: null }
}


/**
 * Providers that answered a forced tool_choice with a rejection, keyed by
 * endpoint+model. The downgrade to "auto" is remembered for the process so one
 * rejection costs one wasted round trip, not one per turn for the whole
 * session. Re-learned after a restart, so a provider that gains support (or a
 * changed config) is picked up on the next boot.
 */
const forcedToolChoiceRejected = new Set<string>()

function toolChoiceKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`
}

/**
 * The tool_choice to send, honouring an earlier rejection from this provider.
 * Only "required" is downgraded: "none" is a deliberate no-tools turn, and
 * rewriting it to "auto" would hand the model tools the caller withheld.
 */
function effectiveToolChoice(
  baseUrl: string,
  model: string,
  requested: "required" | "auto" | "none",
): "required" | "auto" | "none" {
  return requested === "required" && forcedToolChoiceRejected.has(toolChoiceKey(baseUrl, model)) ? "auto" : requested
}

/** Record that this endpoint+model refuses a forced tool_choice. */
function rememberForcedToolChoiceRejection(baseUrl: string, model: string): void {
  forcedToolChoiceRejected.add(toolChoiceKey(baseUrl, model))
}










function promptCacheRequestExtras(baseUrl: string, slot: "primary" | "fallback"): Partial<CompletionRequest> {
  const configuredKey = process.env.OPENAI_PROMPT_CACHE_KEY?.trim()
  let isOfficialOpenAI = false
  try {
    isOfficialOpenAI = new URL(baseUrl).hostname === "api.openai.com"
  } catch {
    // An invalid provider URL will fail when the client sends the request.
  }
  if (!configuredKey && !isOfficialOpenAI) return {}
  return { prompt_cache_key: configuredKey || `${AGENT_ID}:${slot}` }
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
  emitEvents = true,
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
      if (ENABLE_THINKING && emitEvents) {
        reasoningParts.push(delta.reasoning_content)
        emit({ type: "thinking", text: delta.reasoning_content })
        emittedThinking = true
      } else if (ENABLE_THINKING) {
        reasoningParts.push(delta.reasoning_content)
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
      if (emitEvents) {
        emit({ type: "text", text: delta.content })
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
    usage,
    emittedText,
    emittedThinking,
    bufferedThinking: reasoningParts.join(""),
    elapsedMs,
    tokensPerSecond,
  }
}




let isolatedProviderSet: ProviderSet | null = null

/**
 * Provider set for completions that are not the main session turn: delegated
 * task workers and the pre-compaction recollection. Shares the same
 * configuration, so quota failover and circuit state stay consistent.
 */
function isolatedProviders(): ProviderSet {
  return (isolatedProviderSet ??= createProviderSet(resolveProviderConfig(process.env), { agentId: AGENT_ID }))
}

/** Runs one task-local completion without main-session recall, compaction, or stream emission. */
export async function fetchIsolatedCompletion(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  toolDefinitions: ToolDefinition[],
  toolChoice: "required" | "auto" | "none" = "auto",
  options: { model?: string } = {},
): Promise<CompletionTurnResult> {
  const tools = toolDefinitions as OpenAI.Chat.ChatCompletionTool[]
  return completeWithResilience(
    isolatedProviders(),
    { model: "", messages: [], tools, tool_choice: toolChoice },
    { currentMessages: () => sanitizeMessages(messages) },
    // A task worker's output is not the agent's own voice, so it is never
    // streamed to clients.
    { sink: null, toolChoice, ...(options.model ? { model: options.model } : {}) },
  )
}

/**
 * Gives the active agent one tool-free turn to state what it wants carried
 * forward before context is compressed, then appends that exchange to the
 * durable chat log. The compactor separately archives the exact exchange in
 * the LCM source graph without changing which external turn remains active.
 */
export async function collectAgentCompactionRecollection(
  convId: number,
  state: LoopState,
): Promise<string | null> {
  const recollectionMessages = contextArchive().batchActiveContextSummariesForPrompt(
    sanitizeMessages([
      ...state.conversation,
      { role: "system", content: COMPACTION_RECOLLECTION_TURN_INSTRUCTION },
      { role: "user", content: COMPACTION_RECOLLECTION_PROMPT },
    ]),
  )
  const tools: OpenAI.Chat.ChatCompletionTool[] = []

  const keepRecollection = (result: CompletionTurnResult): string | null => {
    applyUsage(state, result.usage, {
      elapsedMs: result.elapsedMs,
      tokensPerSecond: result.tokensPerSecond,
    })
    const content = result.message.content
    if (typeof content !== "string" || !content.trim()) return null
    if (isPathologicalCompactionRecollection(content)) {
      console.warn(
        `[context agent=${AGENT_ID}] recollection: rejected pathological testimony (${content.length} chars); continuing compaction without it`,
      )
      return null
    }

    logMessage(convId, "user", COMPACTION_RECOLLECTION_PROMPT)
    logMessage(convId, "assistant", content)
    emit({ type: "text", text: content })
    console.log(`[context agent=${AGENT_ID}] recollection: appended agent testimony before compaction`)
    return content
  }

  try {
    return keepRecollection(
      await completeWithResilience(
        isolatedProviders(),
        { model: "", messages: [], tools, tool_choice: "none" },
        { currentMessages: () => recollectionMessages },
        { sink: null, toolChoice: "none" },
      ),
    )
  } catch (err) {
    console.warn(
      `[context agent=${AGENT_ID}] recollection: agent testimony unavailable (${errorSummary(err)}); continuing compaction`,
    )
    return null
  }
}




export const __completionTest = {
  consumeCompletionStream,
  effectiveToolChoice,
  rememberForcedToolChoiceRejection,
  resetForcedToolChoiceMemory: () => forcedToolChoiceRejected.clear(),
  isPathologicalCompactionRecollection,
  promptCacheRequestExtras,
  quarantineLatestIncomingForContentFilter,
}
