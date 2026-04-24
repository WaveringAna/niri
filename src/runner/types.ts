import type { Message, RunnerState, UserMessage } from "../types.js"

/** Generic decoded tool arguments object. */
export type ToolArgs = Record<string, any>

/** Supported image detail levels for multimodal requests. */
export type ImageDetail = "auto" | "low" | "high"

/** Mutable state consumed by the runner loop on each turn. */
export interface LoopState {
  conversation: Message[]
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  toolInFlight: boolean
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
}

/** Lifecycle hooks injected by the runner orchestrator into the loop. */
export interface LoopHooks {
  /** Waits for the next incoming event from any trigger source. */
  waitForEvent: () => Promise<UserMessage>
  /** Waits up to timeoutMs for the next event; resolves null on timeout. */
  waitForEventWithTimeout: (timeoutMs: number) => Promise<UserMessage | null>
  /** Injects an incoming event into the in-memory conversation. */
  injectIncomingEvent: (convId: number, event: UserMessage) => void
  /** Flushes events deferred while a tool call was in flight. */
  flushDeferredEvents: () => void
  /** Clears persisted session state when ending a run. */
  clearSession: () => Promise<void>
  /** Persists the current in-memory session state. */
  saveSession: () => Promise<void>
}

/** Internal runtime state for the runner service. */
export interface RunnerStateInternal extends RunnerState {
  toolInFlight: boolean
  deferredEvents: Array<{ event: UserMessage; priority: boolean }>
}
