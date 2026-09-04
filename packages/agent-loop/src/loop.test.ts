import assert from "node:assert/strict"
import { test } from "node:test"
import type OpenAI from "openai"
import type { CompactionOutcome, ContextCompactor, LcmConfig } from "@mira/agent-context"
import type { Provider, ProviderSet } from "@mira/agent-llm"
import { createLoopState, runLoop } from "./loop.js"
import { resolveTools } from "./tools.js"
import { nullEventSink, nullMetricsSink } from "./ports.js"
import type {
  AgentEvent,
  AgentIdentity,
  AgentRuntime,
  LoopHooks,
  SessionStore,
  ToolModule,
  TranscriptStore,
  TurnPolicy,
} from "./index.js"

const IDENTITY: AgentIdentity = { id: "reviewer", name: "reviewer", homeDir: "/tmp/h", stateDir: "/tmp/h/state" }

const LCM: LcmConfig = {
  summaryBatchSize: 4,
  compactTriggerTokens: 1_000_000,
  compactHardTriggerTokens: 2_000_000,
  compactMinNewMessages: 24,
}

/** Assistant turns are scripted; each entry is one model response. */
type ScriptedTurn = { text?: string; calls?: Array<{ name: string; args?: unknown }> }

function scriptedProvider(turns: ScriptedTurn[]): { provider: Provider; seen: number } {
  let index = 0
  const provider: Provider = {
    id: "test\nscripted",
    kind: "openai",
    model: "scripted",
    baseUrl: "test",
    toolChoice: "auto",
    config: { kind: "openai", baseUrl: "test", apiKey: "k", model: "scripted", toolChoice: "auto" },
    async complete() {
      const turn = turns[index++] ?? { text: "done" }
      const message = {
        role: "assistant",
        content: turn.text ?? null,
        refusal: null,
        ...(turn.calls
          ? {
              tool_calls: turn.calls.map((call, i) => ({
                id: `call_${index}_${i}`,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : {}),
      } as OpenAI.Chat.ChatCompletionMessage
      return {
        message,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        emittedText: false,
        emittedThinking: false,
        bufferedThinking: "",
      }
    },
  }
  return { provider, get seen() { return index } }
}

function providerSet(provider: Provider): ProviderSet {
  return {
    primary: provider,
    fallback: null,
    summary: null,
    enableThinking: false,
    async resolvePrimary() { return { provider, slot: "primary" } },
    async resolveSummary() { return null },
    async failoverStatus() { return { active: false, retryAtMs: 0, reason: null } },
    async recordQuotaFailover() { return { active: false, retryAtMs: 0, reason: null } },
    async clearFailover() { return false },
    circuitStatus() { return { open: false, permanent: false } },
    recordFailure() {},
    recordUnusable() {},
    recordSuccess() {},
  }
}

const noopCompactor: ContextCompactor = {
  config: LCM,
  async maybeCompact(input): Promise<CompactionOutcome> {
    return {
      applied: false,
      method: input.phase,
      beforeTokens: input.observedPromptTokens,
      afterTokens: input.observedPromptTokens,
      messages: input.messages,
    }
  },
}

function collectingTranscript(): TranscriptStore & { rows: string[] } {
  const rows: string[] = []
  return {
    rows,
    startConversation: () => 1,
    logMessage(_c, role, content) { rows.push(`${role}: ${content}`) },
    endConversation() {},
  }
}

const memorySession: SessionStore = {
  async load() { return null },
  async save() {},
  async clear() {},
  async loadRestSnapshot() { return null },
  async saveRestSnapshot() {},
}

function restModule(log: string[] = []): ToolModule {
  return {
    name: "lifecycle",
    definitions: () => [
      { type: "function", function: { name: "rest", description: "end the session", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({
      async rest(ctx) {
        log.push("rest")
        ctx.state.conversation.push({ role: "tool", tool_call_id: ctx.call.id, content: "resting" })
        return { shouldRest: true }
      },
    }),
  }
}

function buildRuntime(options: {
  turns: ScriptedTurn[]
  modules?: ToolModule[]
  policies?: TurnPolicy[]
  events?: AgentEvent[]
}): { runtime: AgentRuntime; transcript: ReturnType<typeof collectingTranscript> } {
  const { provider } = scriptedProvider(options.turns)
  const transcript = collectingTranscript()
  const captured = options.events
  const runtime: AgentRuntime = {
    identity: IDENTITY,
    providers: providerSet(provider),
    compactor: noopCompactor,
    session: memorySession,
    transcript,
    events: captured ? { emit: (e) => { captured.push(e) } } : nullEventSink,
    metrics: nullMetricsSink,
    modules: options.modules ?? [restModule()],
    policies: options.policies ?? [],
    getTools() {
      return resolveTools(this.modules, { identity: IDENTITY, runtime: this }).definitions
    },
    async summaryGrounding() { return null },
    async buildBootstrap() { return [] },
  }
  return { runtime, transcript }
}

function hooks(overrides: Partial<LoopHooks> = {}): LoopHooks {
  return {
    async waitForEvent() { return null },
    async waitForEventWithTimeout() { return null },
    injectIncomingEvent() {},
    flushDeferredEvents() {},
    async saveSession() {},
    async saveShutdownSnapshot() {},
    shouldShutdown: () => false,
    resolveShutdown() {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

test("the loop runs turns until a tool signals rest", async () => {
  const log: string[] = []
  const { runtime } = buildRuntime({
    turns: [{ text: "looking", calls: [{ name: "rest" }] }],
    modules: [restModule(log)],
  })
  const state = createLoopState()
  const exit = await runLoop(runtime, 1, state, hooks())
  assert.equal(exit, "rest")
  assert.deepEqual(log, ["rest"])
})

test("tool modules compose, and each keeps its own handlers", async () => {
  const calls: string[] = []
  const github: ToolModule = {
    name: "github",
    definitions: () => [
      { type: "function", function: { name: "fetch_diff", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({
      async fetch_diff(ctx) {
        calls.push("fetch_diff")
        ctx.state.conversation.push({ role: "tool", tool_call_id: ctx.call.id, content: "diff" })
        return {}
      },
    }),
  }
  const { runtime } = buildRuntime({
    turns: [{ calls: [{ name: "fetch_diff" }] }, { calls: [{ name: "rest" }] }],
    modules: [github, restModule()],
  })
  const tools = runtime.getTools().map((t) => t.function.name)
  assert.deepEqual(tools.sort(), ["fetch_diff", "rest"])

  await runLoop(runtime, 1, createLoopState(), hooks())
  assert.deepEqual(calls, ["fetch_diff"])
})

test("two modules claiming one tool name fail loudly at assembly", () => {
  const make = (name: string): ToolModule => ({
    name,
    definitions: () => [
      { type: "function", function: { name: "search", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({ async search() { return {} } }),
  })
  assert.throws(
    () => resolveTools([make("a"), make("b")], { identity: IDENTITY, runtime: {} as AgentRuntime }),
    /registered by both "a" and "b"/,
  )
})

test("a declared tool with no handler is rejected", () => {
  const broken: ToolModule = {
    name: "broken",
    definitions: () => [
      { type: "function", function: { name: "ghost", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({}),
  }
  assert.throws(
    () => resolveTools([broken], { identity: IDENTITY, runtime: {} as AgentRuntime }),
    /declares tool "ghost" but provides no handler/,
  )
})

test("a turn policy can nudge the agent and force another turn", async () => {
  let nudges = 0
  const mustSubmit: TurnPolicy = {
    name: "must-submit-review",
    onTurnEnd(ctx) {
      const submitted = ctx.turnMessages.some(
        (m) => m.role === "assistant" && (m as { tool_calls?: Array<{ function?: { name?: string } }> })
          .tool_calls?.some((c) => c.function?.name === "rest"),
      )
      if (submitted || nudges >= 1) return null
      nudges++
      return "[system] you analysed the diff but never submitted the review."
    },
  }
  const { runtime } = buildRuntime({
    turns: [{ text: "here are my findings" }, { text: "submitting", calls: [{ name: "rest" }] }],
    policies: [mustSubmit],
  })
  const state = createLoopState()
  await runLoop(runtime, 1, state, hooks())

  assert.equal(nudges, 1)
  assert.ok(
    state.conversation.some((m) => m.role === "user" && String(m.content).includes("never submitted the review")),
    "the nudge should be injected into the conversation",
  )
})

test("an unknown tool call is answered with an error, never left dangling", async () => {
  const { runtime, transcript } = buildRuntime({
    turns: [{ calls: [{ name: "does_not_exist" }] }, { calls: [{ name: "rest" }] }],
  })
  await runLoop(runtime, 1, createLoopState(), hooks())
  assert.ok(transcript.rows.some((r) => r.startsWith("tool: error: ") && r.includes("not available")))
})

test("a throwing tool still produces a tool-role reply", async () => {
  const explode: ToolModule = {
    name: "explode",
    definitions: () => [
      { type: "function", function: { name: "boom", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({ async boom(): Promise<never> { throw new Error("kaboom") } }),
  }
  const { runtime, transcript } = buildRuntime({
    turns: [{ calls: [{ name: "boom" }] }, { calls: [{ name: "rest" }] }],
    modules: [explode, restModule()],
  })
  await runLoop(runtime, 1, createLoopState(), hooks())
  assert.ok(transcript.rows.some((r) => r.includes("kaboom")))
})

test("malformed tool arguments are reported instead of crashing the turn", async () => {
  const { runtime, transcript } = buildRuntime({ turns: [{ calls: [{ name: "rest" }] }] })
  const state = createLoopState()
  // Force invalid JSON through the same path the provider would produce.
  const original = runtime.providers.resolvePrimary.bind(runtime.providers)
  let first = true
  runtime.providers.resolvePrimary = async () => {
    const resolved = (await original())!
    if (!first) return resolved
    first = false
    return {
      ...resolved,
      provider: {
        ...resolved.provider,
        async complete() {
          return {
            message: {
              role: "assistant", content: null, refusal: null,
              tool_calls: [{ id: "c1", type: "function" as const, function: { name: "rest", arguments: "{not json" } }],
            } as OpenAI.Chat.ChatCompletionMessage,
            emittedText: false, emittedThinking: false, bufferedThinking: "",
          }
        },
      },
    }
  }
  await runLoop(runtime, 1, state, hooks())
  assert.ok(transcript.rows.some((r) => r.includes("invalid arguments for rest")))
})

test("an event arriving mid-turn preempts the remaining tool calls", async () => {
  const ran: string[] = []
  const slow: ToolModule = {
    name: "slow",
    definitions: () => [
      { type: "function", function: { name: "step", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({
      async step(ctx) {
        ran.push("step")
        // Simulate a DM landing while the first tool was running.
        if (ran.length === 1) {
          ctx.state.pendingInputs.push({ source: "discord", content: "hey", triggeredAt: new Date().toISOString() })
        }
        ctx.state.conversation.push({ role: "tool", tool_call_id: ctx.call.id, content: "ok" })
        return {}
      },
    }),
  }
  const injected: string[] = []
  const { runtime, transcript } = buildRuntime({
    turns: [{ calls: [{ name: "step" }, { name: "step" }, { name: "step" }] }, { calls: [{ name: "rest" }] }],
    modules: [slow, restModule()],
  })
  await runLoop(runtime, 1, createLoopState(), hooks({
    injectIncomingEvent: (_c, e) => { injected.push(e.source) },
  }))

  assert.equal(ran.length, 1, "only the first call runs before the interrupt")
  assert.deepEqual(injected, ["discord"])
  assert.equal(transcript.rows.filter((r) => r.includes("interrupted by incoming discord")).length, 2)
})

test("secrets in tool arguments are redacted on the event stream", async () => {
  const events: AgentEvent[] = []
  const auth: ToolModule = {
    name: "auth",
    definitions: () => [
      { type: "function", function: { name: "login", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({
      async login(ctx) {
        const { recordToolResult } = await import("./tools.js")
        recordToolResult(ctx.runtime, ctx.convId, ctx.state, ctx.call, "login", ctx.args, "ok")
        return {}
      },
    }),
  }
  const { runtime } = buildRuntime({
    turns: [{ calls: [{ name: "login", args: { user: "ana", api_key: "sk-secret-value" } }] }, { calls: [{ name: "rest" }] }],
    modules: [auth, restModule()],
    events,
  })
  await runLoop(runtime, 1, createLoopState(), hooks())

  const toolEvent = events.find((e) => e.type === "tool" && e.name === "login")
  assert.ok(toolEvent && toolEvent.type === "tool")
  assert.equal(toolEvent.args.user, "ana")
  assert.equal(toolEvent.args.api_key, "[redacted]")
})

test("shutdown mid-loop persists a snapshot and exits", async () => {
  let snapshots = 0
  let resolved = 0
  const noop: ToolModule = {
    name: "noop",
    definitions: () => [
      { type: "function", function: { name: "noop", description: "d", parameters: { type: "object", properties: {} } } },
    ],
    handlers: () => ({
      async noop(ctx) {
        ctx.state.conversation.push({ role: "tool", tool_call_id: ctx.call.id, content: "ok" })
        return {}
      },
    }),
  }
  const { runtime } = buildRuntime({ turns: [{ calls: [{ name: "noop" }] }], modules: [noop] })
  const exit = await runLoop(runtime, 1, createLoopState(), hooks({
    shouldShutdown: () => true,
    saveShutdownSnapshot: async () => { snapshots++ },
    resolveShutdown: () => { resolved++ },
  }))
  assert.equal(exit, "rest")
  assert.equal(snapshots, 1)
  assert.equal(resolved, 1)
})
