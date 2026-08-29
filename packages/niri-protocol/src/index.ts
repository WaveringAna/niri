export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "user"; text: string; source: string; triggeredAt: string; clientId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string }
  | {
      type: "usage"
      promptTokens?: number
      cachedPromptTokens?: number
      cacheWriteTokens?: number
      completionTokens?: number
      totalTokens?: number
      elapsedMs?: number
      tokensPerSecond?: number
    }

export type TriggerSource = "discord" | "bsky" | "webhook" | "cron" | "chat" | "delegation" | "process_job"

export interface UserMessage {
  source: TriggerSource
  triggeredAt: string
  content: string
  clientId?: string
  raw: unknown
}

export type WorkerEventType =
  | "worker.hello"
  | "worker.heartbeat"
  | "runner.status"
  | "stream.event"
  | "metric.recorded"
  | "conversation.started"
  | "conversation.message"
  | "conversation.ended"

export interface WorkerEvent<T = unknown> {
  id: string
  agentId: string
  seq: number
  type: WorkerEventType
  createdAt: string
  payload: T
}

export type ControlCommand = {
  type: "event.enqueue"
  event: UserMessage
  options?: { onlyIfWaiting?: boolean; priority?: boolean }
}
