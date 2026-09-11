import type { LoopState } from "@mira/agent-loop"

/** Passive memory recall bookkeeping owned by Niri rather than the generic loop. */
export type RecallState = {
  cooldowns: Record<number, number>
  turn: number
  pending: boolean
}

const RECALL_KEY = "memory"

export function recallState(state: LoopState): RecallState {
  let recall = state.extras.get(RECALL_KEY) as RecallState | undefined
  if (!recall) {
    recall = { cooldowns: {}, turn: 0, pending: false }
    state.extras.set(RECALL_KEY, recall)
  }
  return recall
}

/** Marks a new incoming turn so passive recall runs exactly once for it. */
export function markRecallPending(state: LoopState): void {
  recallState(state).pending = true
}
