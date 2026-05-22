import OpenAI from "openai"
import type { LoopHooks, LoopState } from "./types"

export type FunctionToolCall = OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }

export type ToolArgs = {
  command?: string
  query?: string
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
  [key: string]: unknown
}

export type ToolExecutionOutcome = { shouldRest?: boolean; isWait?: boolean }

export type CompletionTurnResult = {
  message: OpenAI.Chat.ChatCompletionMessage
  usage?: OpenAI.Completions.CompletionUsage
  emittedText: boolean
  emittedThinking: boolean
  bufferedThinking: string
  /** Runner-measured completion stream duration in milliseconds. */
  elapsedMs?: number
  /** Runner-computed completion throughput in tokens per second. */
  tokensPerSecond?: number
}

export type CompletionRequest = {
  model: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools: OpenAI.Chat.ChatCompletionTool[]
  tool_choice: "required" | "auto" | "none"
  include_reasoning?: boolean
  reasoning?: { enabled?: boolean; exclude?: boolean; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" }
  provider?: { require_parameters?: boolean }
  enable_thinking?: boolean
  chat_template_kwargs?: { enable_thinking?: boolean }
}

export type ToolCallAssembly = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ToolArgKey = keyof ToolArgs
export type ArgTuple<K extends readonly ToolArgKey[]> = { [I in keyof K]: ToolArgs[K[I]] }

export type ToolExecutionContext = {
  convId: number
  state: LoopState
  hooks: LoopHooks
  call: FunctionToolCall
  args: ToolArgs
}

export type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>
