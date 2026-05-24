import type { Message, RunnerState, UserMessage } from "../types"

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
  /**
   * True only on the first assistant step after a new incoming event. Memory
   * recall runs once per turn rather than on every agentic iteration so it
   * doesn't flood context while the assistant works through a single turn.
   */
  memoryRecallPending: boolean
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
