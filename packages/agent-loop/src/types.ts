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

/** Mutable state for one wake cycle. */
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

/** Parsed tool arguments. Modules narrow their own. */
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
  /**
   * Loop control. Only lifecycle tools (`wait`, `wait_then_continue`, `rest`)
   * legitimately need this; everything else should work through `runtime`.
   */
  hooks: LoopHooks
  call: FunctionToolCall
  args: ToolArgs
}

export type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>

/**
 * Context a module gets when asked what it offers. Recomputed each turn, so a
 * module can vary its surface with live conditions — hiding tools whose
 * backing service is down, for instance.
 */
export type ToolModuleContext = {
  identity: AgentIdentity
  runtime: AgentRuntime
}

/** Loop-scoped context, for modules that vary their surface per wake. */
export type ToolModuleRunContext = ToolModuleContext & { hooks: LoopHooks }

/** A cohesive group of tools, contributed independently. */
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

/** A cross-cutting behavioral rule applied around each turn. */
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
 * Nothing here is read from the environment at import time.
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
  /** Background on the agent, prepended to summarization prompts. */
  summaryGrounding(): Promise<SummaryGrounding>
  /** Build the opening conversation for a fresh wake. */
  buildBootstrap(input: AgentInput): Promise<Message[]>

  /**
   * Last transform before a request is sent, re-run on every attempt.
   * Returning `messages` unchanged is a valid implementation.
   */
  prepareCompletionMessages?(messages: Message[], state: LoopState): Promise<Message[]> | Message[]

  /**
   * The provider rejected the prompt as too large. Shrink the conversation
   * (compact, drop attachments) and return true to retry.
   */
  onPromptTooLarge?(state: LoopState, attempt: number): Promise<boolean> | boolean

  /**
   * The provider refused the content. Both safety filters and image-parse
   * failures persist across turns when the offending content is saved in the
   * conversation, which crash-loops an agent on restart — so recovery means
   * mutating `state.conversation`. Return true to retry.
   */
  onContentRejected?(
    state: LoopState,
    kind: "content_filter" | "image_parse",
    attempt: number,
  ): Promise<boolean> | boolean
}

/**
 * Callbacks the loop needs from its driver — the session manager that owns
 * event queueing and shutdown.
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
