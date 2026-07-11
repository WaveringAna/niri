import OpenAI from "openai"
import type { LoopState } from "./types"
import type { FunctionToolCall } from "./loop-shared"

/**
 * Normalizes assistant/tool message content into plain text.
 *
 * @param content - Raw OpenAI-compatible message content.
 * @returns Trimmed text representation.
 */
export function assistantContentText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  let combined = ""
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>

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

/**
 * Returns the most recent assistant message text from loop state.
 *
 * @param state - Mutable loop state.
 * @returns Latest assistant text, or empty string when none exists.
 */
export function latestAssistantContent(state: LoopState): string {
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
export function isFunctionToolCall(call: OpenAI.Chat.ChatCompletionMessageToolCall): call is FunctionToolCall {
  return call.type === "function"
}
