import type OpenAI from "openai"
import type { UserMessage } from "@niri/protocol"

export type { TriggerSource, UserMessage } from "@niri/protocol"

export type AssistantMessageWithReasoning = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string
}

export type Message = OpenAI.Chat.ChatCompletionMessageParam | AssistantMessageWithReasoning

export interface RunnerState {
  running: boolean
  conversation: Message[]
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
  memoryRecallPending: boolean
}
