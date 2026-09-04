import OpenAI from "openai"
import type { ToolExecutionContext as AgentToolExecutionContext } from "@mira/agent-loop"

export type FunctionToolCall = OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }

export type ToolArgs = {
  command?: string
  session_id?: string
  job_id?: string
  task_id?: string
  profile?: string
  objective?: string
  message?: string
  after_seq?: number
  query?: string
  max_lines?: number
  timeout_ms?: number
  path?: string
  start_line?: number
  end_line?: number
  hashline?: boolean
  target?: string
  note?: string
  detail?: string
  limit?: number
  offset?: number
  summary_id?: string
  id?: string
  tokenCap?: number
  status?: string
  item_id?: string
  action?: string
  posture?: string
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
  prompt_cache_key?: string
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

/**
 * Handlers run under the loop from `@mira/agent-loop`, so its context is the
 * authority. Declaring a local shape here would let the two drift and be caught
 * only at runtime.
 */
export type ToolExecutionContext = Omit<AgentToolExecutionContext, "args"> & { args: ToolArgs }

export type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>
