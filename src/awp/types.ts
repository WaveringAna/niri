import type { StreamEvent } from "../stream"
import type { MetricEvent } from "../metrics"
import type { UserMessage } from "../types"

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

export type WorkerStatus = {
  agentId: string
  running: boolean
  idle: boolean
}

export type EnqueueEventCommand = {
  type: "event.enqueue"
  event: UserMessage
  options?: {
    onlyIfWaiting?: boolean
    priority?: boolean
  }
}

export type WorkerShutdownCommand = {
  type: "worker.shutdown"
}

export type ControlCommand = EnqueueEventCommand | WorkerShutdownCommand

export type StreamWorkerEventPayload = StreamEvent

export type MetricRecordedPayload = MetricEvent & {
  id: number
}

export type ConversationStartedPayload = {
  conversationId: number
  source: string
  startedAt: string
}

export type ConversationMessagePayload = {
  conversationId: number
  role: string
  content: string
  toolCalls?: unknown
  toolCallId?: string
  createdAt: string
}

export type ConversationEndedPayload = {
  conversationId: number
  tokens: number
  endedAt: string
}
