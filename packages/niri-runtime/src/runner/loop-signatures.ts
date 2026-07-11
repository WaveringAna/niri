import OpenAI from "openai"
import { assistantContentText } from "./loop-content"
import { parseToolArguments } from "./util"
import type { FunctionToolCall } from "./loop-shared"

const MAX_TOOL_RESULT_SIGNATURE_CHARS = 600

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b))
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
  return `{${entries.join(",")}}`
}

function truncateForSignature(text: string, maxChars = MAX_TOOL_RESULT_SIGNATURE_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function parseToolArgumentsForSignature(raw: string): unknown {
  const parsed = parseToolArguments(raw)
  if (parsed.ok) return parsed.args
  return { _parse_error: parsed.error, raw }
}

function collectToolCallSignature(message: OpenAI.Chat.ChatCompletionMessageParam): string | null {
  if (message.role !== "assistant") return null

  const maybeCalls = (message as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls
  if (!Array.isArray(maybeCalls) || maybeCalls.length === 0) {
    const content = assistantContentText((message as OpenAI.Chat.ChatCompletionAssistantMessageParam).content)
    return stableSerialize({ no_tools: content || "(empty)" })
  }

  const functionCalls = maybeCalls
    .filter((call): call is FunctionToolCall => call.type === "function")
    .map((call) => ({
      name: call.function.name,
      args: parseToolArgumentsForSignature(call.function.arguments),
    }))

  if (functionCalls.length === 0) {
    const content = assistantContentText((message as OpenAI.Chat.ChatCompletionAssistantMessageParam).content)
    return stableSerialize({ no_function_tools: content || "(empty)" })
  }

  return stableSerialize(functionCalls)
}

function collectToolResultSignature(messages: OpenAI.Chat.ChatCompletionMessageParam[]): string[] {
  return messages
    .filter((message): message is OpenAI.Chat.ChatCompletionToolMessageParam => message.role === "tool")
    .map((toolMessage) => {
      const content = assistantContentText(toolMessage.content)
      return stableSerialize({
        tool_call_id: toolMessage.tool_call_id,
        content: truncateForSignature(content),
      })
    })
}

/**
 * Checks whether a turn slice contains an injected incoming user event.
 *
 * @param messages - Turn-local conversation messages.
 * @returns `true` when any user-role message is present.
 */
export function hasIncomingUserMessage(messages: OpenAI.Chat.ChatCompletionMessageParam[]): boolean {
  return messages.some((message) => message.role === "user")
}

/**
 * Builds a stable signature for one assistant turn (calls + tool results).
 *
 * @param turnMessages - Messages generated during a single loop turn.
 * @returns Stable signature string, or `null` when no assistant message exists.
 */
export function buildTurnSignature(turnMessages: OpenAI.Chat.ChatCompletionMessageParam[]): string | null {
  const assistantMessage = turnMessages.find((message) => message.role === "assistant")
  if (!assistantMessage) return null

  const callSignature = collectToolCallSignature(assistantMessage)
  if (!callSignature) return null

  return stableSerialize({
    calls: callSignature,
    results: collectToolResultSignature(turnMessages),
  })
}
