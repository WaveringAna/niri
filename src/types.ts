import type OpenAI from "openai"

export type Message = OpenAI.Chat.ChatCompletionMessageParam

export type TriggerSource = "discord" | "bsky" | "webhook" | "cron" | "chat"

export interface UserMessage {
  source: TriggerSource
  triggeredAt: string
  content: string
  clientId?: string
  raw: unknown
}

export interface RunnerState {
  running: boolean
  conversation: Message[]
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
}
