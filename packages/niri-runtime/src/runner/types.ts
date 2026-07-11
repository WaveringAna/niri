import type { Message, RunnerState, UserMessage } from "../types"
import type { ClientToolExecutor, ToolDefinition } from "@mira/harness-core"

export type ImageDetail = "auto" | "low" | "high"

export interface LoopState {
  conversation: Message[]
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  toolInFlight: boolean
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
  memoryRecallPending: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
}

export interface LoopHooks {
  clientTools: ClientToolExecutor
  getTools: () => ToolDefinition[]
  waitForEvent: () => Promise<UserMessage | null>
  waitForEventWithTimeout: (timeoutMs: number) => Promise<UserMessage | null>
  injectIncomingEvent: (convId: number, event: UserMessage) => void
  flushDeferredEvents: () => void
  clearSession: () => Promise<void>
  saveSession: () => Promise<void>
  saveShutdownSnapshot: () => Promise<void>
  shouldShutdown: () => boolean
  resolveShutdown: () => void
}

export interface RunnerStateInternal extends RunnerState {
  toolInFlight: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
  deferredEvents: Array<{ event: UserMessage; priority: boolean }>
}
