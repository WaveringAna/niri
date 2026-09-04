import type { Message } from "@mira/agent-context"

/** Ports the loop needs from its host. */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string }
  | { type: "user"; source: string; text: string; triggeredAt: string; clientId?: string }
  | { type: "usage"; tokenCount: number; contextSize: number; tokensPerSecond?: number }
  | { type: "presence"; state: "awake" | "resting" }

export interface EventSink {
  emit(event: AgentEvent): void
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export type TranscriptToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** Durable per-conversation message log. Distinct from the context archive. */
export interface TranscriptStore {
  startConversation(source: string, startedAt: string): number
  logMessage(
    convId: number,
    role: string,
    content: string,
    toolCalls?: TranscriptToolCall[],
    toolCallId?: string,
  ): void
  endConversation(convId: number, tokens: number): void
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type AgentMetric =
  | { type: "compaction"; before: number; after: number; method: string; summary?: string }
  | { type: "prompt_response"; promptMetricId?: number; model: string; toolChoice: string; messages: unknown; response: unknown; usage?: unknown }
  | { type: "provider_failover"; from: string; to: string; reason: string }

export interface MetricsSink {
  record(metric: AgentMetric): void
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export type RestSnapshot = {
  restedAt: string
  note?: string
  /** Active summary segments at rest, restored on the next wake. */
  segments: string[]
}

export interface SessionStore {
  load(): Promise<Message[] | null>
  save(messages: Message[]): Promise<void>
  clear(): Promise<void>
  loadRestSnapshot(): Promise<RestSnapshot | null>
  saveRestSnapshot(messages: Message[], note?: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Who this agent is and where its durable state lives. */
export type AgentIdentity = {
  /** Stable id used by the control plane and metric keys. */
  id: string
  /** Display name used in summarizer prompts. */
  name: string
  homeDir: string
  stateDir: string
}

/** No-op sinks, for tests and for hosts that don't want a given signal. */
export const nullEventSink: EventSink = { emit() {} }
export const nullMetricsSink: MetricsSink = { record() {} }
