import type { LoopState as AgentLoopState } from "@mira/agent-loop"

export type ImageDetail = "auto" | "low" | "high"

/**
 * The loop's own state, re-exported so runtime code has one name for it.
 * Declaring a separate shape here is how the tool context silently drifted
 * from what the loop actually passes.
 */
export type LoopState = AgentLoopState
