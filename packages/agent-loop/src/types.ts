import type OpenAI from "openai"
import type { ToolDefinition } from "@mira/harness-core"
import type { Message, ContextCompactor, SummaryGrounding } from "@mira/agent-context"
import type { ProviderSet } from "@mira/agent-llm"
import type {
  AgentIdentity,
  EventSink,
  MetricsSink,
  SessionStore,
  TranscriptStore,
} from "./ports.js"

// ---------------------------------------------------------------------------
// Events into the loop
// ---------------------------------------------------------------------------

/** Something that wakes or steers a running agent. */
export type AgentInput = {
  /** Free-form origin label: `discord`, `heartbeat`, `webhook`, `github-pr`. */
  source: string
  content: string
  triggeredAt: string
  clientId?: string
}

export type EnqueueOptions = {
  /** Drop the event unless the loop is currently blocked in a wait. */
  onlyIfWaiting?: boolean
  /** Jump the queue. */
  priority?: boolean
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

/**
 * Mutable state for one wake cycle.
 *
 * Note what is *not* here any more: `memoryRecallCooldowns`, `memoryRecallTurn`,
 * and `memoryRecallPending` moved into Niri's memory `ToolModule`, since no
 * other harness has passive memory recall. Extensions keep their own state in
 * `extras`, keyed by module name.
 */
export interface LoopState {
  conversation: Message[]
  pendingInputs: AgentInput[]
  tokenCount: number
  contextSize: number
  toolInFlight: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
  /** Per-module scratch state, keyed by `ToolModule.name`. */
  extras: Map<string, unknown>
}

export type LoopBudget = {
  tokenCount: number
  contextSize: number
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type FunctionToolCall = OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }

/**
 * Parsed tool arguments. Left as an open record rather than the old closed
 * `ToolArgs` union — that union had accumulated every Discord and memory field
 * in the codebase, which is precisely the coupling being removed. Modules
 * narrow their own arguments.
 */
export type ToolArgs = Record<string, unknown>

/** Control signals a tool can send back to the loop. */
export type ToolExecutionOutcome = {
  /** End the session; the loop returns `"rest"`. */
  shouldRest?: boolean
  /** This tool blocks on external input; don't treat it as work in flight. */
  isWait?: boolean
}

export type ToolExecutionContext = {
  convId: number
  state: LoopState
  runtime: AgentRuntime
  call: FunctionToolCall
  args: ToolArgs
}

export type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>

/**
 * Context a module gets when asked what it offers. Recomputed each turn, so a
 * module can vary its surface with live conditions (Niri hides Discord tools
 * when the gateway is down).
 */
export type ToolModuleContext = {
  identity: AgentIdentity
  runtime: AgentRuntime
}

/**
 * A cohesive group of tools, contributed independently.
 *
 * This is the replacement for the 800-line `loop-tool-registry.ts` that
 * statically imported Discord, memory, posture, work-ledger, process-jobs and
 * delegation. Niri now registers those as modules; a PR reviewer registers
 * `githubTools`, `diffTools`, `reviewTools` and gets none of Niri's.
 */
export type ToolModule = {
  name: string
  /** Tool schemas shown to the model. Return `[]` to disable dynamically. */
  definitions(ctx: ToolModuleContext): ToolDefinition[]
  /** Handlers keyed by tool name. Must cover every name in `definitions`. */
  handlers(ctx: ToolModuleContext): Record<string, ToolHandler>
  /** Optional per-wake setup; return value lands in `state.extras[name]`. */
  init?(ctx: ToolModuleContext): unknown
}

// ---------------------------------------------------------------------------
// Turn policies
// ---------------------------------------------------------------------------

export type TurnPolicyContext = {
  convId: number
  state: LoopState
  runtime: AgentRuntime
  /** Messages appended during the turn that just finished. */
  turnMessages: Message[]
  /** Whether the assistant called any tool this turn. */
  calledTools: boolean
}

/**
 * A cross-cutting behavioral rule applied around each turn.
 *
 * This is where `applyDiscordSendNudge` goes — it was Discord-specific logic
 * sitting in the core loop. Niri registers it as a policy; a PR reviewer
 * registers "you analysed the diff but never called submit_review".
 */
export type TurnPolicy = {
  name: string
  /** Runs before the model turn. May mutate `state.conversation`. */
  onTurnStart?(ctx: TurnPolicyContext): Promise<void> | void
  /**
   * Runs after the assistant's turn. Return a string to inject it as a user
   * message and immediately re-run the turn without waiting.
   */
  onTurnEnd?(ctx: TurnPolicyContext): string | null | Promise<string | null>
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Everything one agent needs to run, assembled by the host.
 *
 * Constructing this is the whole of "wiring up a harness": pick providers,
 * a compactor, tool modules, policies and a prompt builder. Nothing is read
 * from the environment at import time.
 */
export interface AgentRuntime {
  readonly identity: AgentIdentity
  readonly providers: ProviderSet
  readonly compactor: ContextCompactor
  readonly session: SessionStore
  readonly transcript: TranscriptStore
  readonly events: EventSink
  readonly metrics: MetricsSink
  readonly modules: readonly ToolModule[]
  readonly policies: readonly TurnPolicy[]

  /** Full tool surface for this turn, across all modules. */
  getTools(): ToolDefinition[]
  /** Grounding text for summarization; Niri returns soul + core + journal. */
  summaryGrounding(): Promise<SummaryGrounding>
  /** Build the opening conversation for a fresh wake. */
  buildBootstrap(input: AgentInput): Promise<Message[]>
}

/**
 * Side-effecting callbacks the loop needs from its driver (the session manager
 * that owns event queueing and shutdown). Narrower than the old `LoopHooks`:
 * `clientTools` and `getTools` moved onto `AgentRuntime`.
 */
export interface LoopHooks {
  waitForEvent(): Promise<AgentInput | null>
  waitForEventWithTimeout(timeoutMs: number): Promise<AgentInput | null>
  injectIncomingEvent(convId: number, event: AgentInput): void
  enqueueEvent?(event: AgentInput, options?: EnqueueOptions): boolean
  flushDeferredEvents(): void
  saveSession(): Promise<void>
  saveShutdownSnapshot(): Promise<void>
  shouldShutdown(): boolean
  resolveShutdown(): void
}

export type RunLoopExit = "rest"

export type LoopConfig = {
  /** Inferred wait when the model answers without calling a tool. */
  implicitContinuationMs: number
  /** Keep at least this many trailing messages verbatim through compaction. */
  recentMinKeep: number
  recentMaxKeep: number
  tailCharBudget: number
}

export const defaultLoopConfig: LoopConfig = {
  implicitContinuationMs: 10 * 60_000,
  recentMinKeep: 6,
  recentMaxKeep: 40,
  tailCharBudget: 60_000,
}
