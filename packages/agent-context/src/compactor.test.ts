import assert from "node:assert/strict"
import { test } from "node:test"
import Database from "better-sqlite3"
import { createSqliteContextArchive } from "./sqlite-archive.js"
import { createLcmEngine } from "./lcm.js"
import {
  createContextCompactor,
  defaultPruneConfig,
  pruneToolOutputsForCompaction,
  shouldDeferSmallFollowUpCompaction,
} from "./compactor.js"
import { defaultSummaryPrompts } from "./prompts.js"
import type { LcmConfig, Message, SummarizerModel, SummaryCircuit } from "./types.js"

/** Niri's production thresholds, which the deferral tests are written against. */
const LCM_DEFER: LcmConfig = {
  summaryBatchSize: 4,
  compactTriggerTokens: 90_000,
  compactHardTriggerTokens: 115_000,
  compactMinNewMessages: 24,
}

const LCM: LcmConfig = {
  summaryBatchSize: 4,
  compactTriggerTokens: 1_000,
  compactHardTriggerTokens: 2_000,
  compactMinNewMessages: 2,
}

const SUMMARY_TEXT =
  "thread A — auth middleware: reviewed and approved the token refresh path; no findings. " +
  "thread B — error handling: still open, the retry wrapper at src/foo.ts:12 swallows the original cause."

function fakeSummarizer(text = SUMMARY_TEXT): {
  model: SummarizerModel
  circuit: SummaryCircuit
  calls: Array<{ system: string; user: string }>
  unusable: string[]
} {
  const calls: Array<{ system: string; user: string }> = []
  const unusable: string[] = []
  return {
    calls,
    unusable,
    model: {
      id: "test\nfake-model",
      model: "fake-model",
      async completeText(system, user) {
        calls.push({ system, user })
        return text
      },
    },
    circuit: {
      isOpen: () => false,
      recordFailure() {},
      recordUnusable(reason) {
        unusable.push(reason)
      },
      recordSuccess() {},
    },
  }
}

function build(text?: string) {
  const db = new Database(":memory:")
  const archive = createSqliteContextArchive(db)
  const lcm = createLcmEngine({ archive, agentName: "reviewer", batchSize: LCM.summaryBatchSize })
  const summarizer = fakeSummarizer(text)
  const compactor = createContextCompactor({
    agentName: "reviewer",
    archive,
    lcm,
    config: LCM,
    prompts: defaultSummaryPrompts,
    prune: { ...defaultPruneConfig, protectedToolNames: () => false },
    resolveSummarizer: async () => ({ model: summarizer.model, circuit: summarizer.circuit }),
    recentMinKeep: 2,
    recentMaxKeep: 6,
    tailCharBudget: 8_000,
  })
  return { db, archive, lcm, compactor, summarizer }
}

function conversation(rawMessages: number, charsEach = 400): Message[] {
  const out: Message[] = [{ role: "system", content: "you review pull requests." }]
  for (let i = 0; i < rawMessages; i++) {
    out.push({ role: "user", content: `request ${i}: ${"x".repeat(charsEach)}` })
    out.push({ role: "assistant", content: `answer ${i}: ${"y".repeat(charsEach)}` })
  }
  return out
}

test("below the trigger, compaction is a no-op that returns the input untouched", async () => {
  const { compactor } = build()
  const messages = conversation(2)
  const result = await compactor.maybeCompact({ messages, observedPromptTokens: 10, phase: "pre-turn" })
  assert.equal(result.applied, false)
  assert.equal(result.messages, messages)
})

test("compaction replaces the middle with a summary and preserves the tail verbatim", async () => {
  const { compactor, summarizer } = build()
  const messages = conversation(20)
  const result = await compactor.maybeCompact({ messages, observedPromptTokens: 5_000, phase: "pre-turn" })

  assert.equal(result.applied, true)
  assert.ok(result.messages.length < messages.length)
  assert.ok(result.afterTokens < result.beforeTokens)
  assert.equal(result.messages[0], messages[0], "leading system message is preserved")
  // The last raw exchange must survive verbatim.
  assert.deepEqual(result.messages.at(-1), messages.at(-1))
  assert.ok(summarizer.calls.length > 0)
})

test("the archive keeps compacted messages verbatim and grep can recover them", async () => {
  const { archive, compactor } = build()
  const messages = conversation(20)
  messages[3] = { role: "assistant", content: `distinctive-marker-zebra ${"z".repeat(400)}` }

  const result = await compactor.maybeCompact({ messages, observedPromptTokens: 5_000, phase: "pre-turn" })
  assert.equal(result.applied, true)
  // Gone from the live conversation...
  assert.ok(!JSON.stringify(result.messages).includes("distinctive-marker-zebra"))
  // ...but still recoverable from the archive.
  const hits = archive.grep("distinctive-marker-zebra")
  assert.equal(hits.length, 1)
  assert.ok(hits[0]!.content.includes("distinctive-marker-zebra"))
  assert.ok(hits[0]!.summaryIds.length > 0, "hit is attributed to the summary that replaced it")
})

test("a summary can be described and expanded back to its source messages", async () => {
  const { archive, compactor } = build()
  const result = await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
  })
  const summaryId = result.leafSummaryId!
  assert.ok(summaryId)

  const described = archive.describe(summaryId)
  assert.equal(described?.id, summaryId)
  assert.ok(described!.summary.directSources.messageCount > 0)

  const expanded = archive.expand(summaryId, 0, 5)
  assert.equal(expanded?.summaryId, summaryId)
  assert.ok(expanded!.messages.length > 0)
  assert.ok(expanded!.totalMessages >= expanded!.messages.length)
})

test("the agent's own recollection is woven into the summary prompt", async () => {
  const { compactor, summarizer } = build()
  await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
    directRecollection: async () => "I was halfway through auditing the auth middleware.",
  })
  const wove = summarizer.calls.some((call) => call.system.includes("auditing the auth middleware"))
  assert.ok(wove, "recollection should reach the summarizer system prompt")
})

test("grounding reaches the summarizer without being asserted as fact", async () => {
  const { compactor, summarizer } = build()
  await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
    grounding: "the reviewer enforces the repo's error-handling rubric.",
  })
  const call = summarizer.calls[0]!
  assert.ok(call.system.includes("error-handling rubric"))
  assert.ok(call.system.includes("Do NOT pull facts from this grounding"))
})

test("a summary that fails to reduce the transcript is rejected", async () => {
  // Summarizer echoes something longer than what it replaced.
  const { compactor, summarizer } = build("q".repeat(60_000))
  const result = await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
  })
  assert.equal(result.applied, false)
  assert.ok(summarizer.unusable.some((r) => /did not reduce/.test(r)))
})

test("a meta-reply from the summarizer is rejected rather than stored as memory", async () => {
  const { compactor, summarizer } = build("Could you please share the transcript you would like me to summarize?")
  const result = await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
  })
  assert.equal(result.applied, false)
  assert.ok(summarizer.unusable.some((r) => /meta-reply/.test(r)))
})

test("an open summarizer circuit skips compaction instead of stalling", async () => {
  const { compactor } = (() => {
    const db = new Database(":memory:")
    const archive = createSqliteContextArchive(db)
    const lcm = createLcmEngine({ archive, agentName: "r", batchSize: 4 })
    return {
      compactor: createContextCompactor({
        agentName: "r",
        archive,
        lcm,
        config: LCM,
        prompts: defaultSummaryPrompts,
        prune: { ...defaultPruneConfig, protectedToolNames: () => false },
        resolveSummarizer: async () => null,
        recentMinKeep: 2,
        recentMaxKeep: 6,
        tailCharBudget: 8_000,
      }),
    }
  })()
  const result = await compactor.maybeCompact({
    messages: conversation(20),
    observedPromptTokens: 5_000,
    phase: "pre-turn",
  })
  assert.equal(result.applied, false)
})

test("tool-output pruning excerpts large results and respects protected tools", () => {
  const big = "L".repeat(20_000)
  const messages: Message[] = [
    { role: "assistant", content: null, tool_calls: [
      { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "memory_read", arguments: "{}" } },
    ] } as Message,
    { role: "tool", tool_call_id: "a", content: big } as Message,
    { role: "tool", tool_call_id: "b", content: big } as Message,
    { role: "assistant", content: "T".repeat(45_000) },
  ]
  const config = { ...defaultPruneConfig, protectedToolNames: (n: string) => n.startsWith("memory_") }
  const pruned = pruneToolOutputsForCompaction(messages, config)

  assert.equal(pruned.prunedMessages, 1)
  assert.ok(String(pruned.messages[1]!.content).startsWith(config.marker), "read_file output is excerpted")
  assert.equal(pruned.messages[2]!.content, big, "memory_read output is protected")
})

test("pruning is skipped when the saving would be trivial", () => {
  const messages: Message[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "sh", arguments: "{}" } }] } as Message,
    { role: "tool", tool_call_id: "a", content: "S".repeat(2_500) } as Message,
    { role: "assistant", content: "T".repeat(45_000) },
  ]
  const pruned = pruneToolOutputsForCompaction(messages, { ...defaultPruneConfig, protectedToolNames: () => false })
  assert.equal(pruned.prunedMessages, 0)
  assert.equal(pruned.messages, messages)
})

test("two agents in one process keep separate archives", async () => {
  const a = build()
  const b = build()
  await a.compactor.maybeCompact({ messages: conversation(20), observedPromptTokens: 5_000, phase: "pre-turn" })
  assert.ok(a.archive.grep("request 1").length > 0)
  assert.equal(b.archive.grep("request 1").length, 0)
})

test("a small follow-up compaction waits for a meaningful batch of new messages", () => {
  // Summarizing a handful of new messages costs a model call and produces a
  // worse summary than it saves, so defer until enough has accumulated.
  assert.equal(shouldDeferSmallFollowUpCompaction(true, 8, 90_000, LCM_DEFER), true)
  assert.equal(shouldDeferSmallFollowUpCompaction(true, 24, 90_000, LCM_DEFER), false)
  // With no prior summary there is nothing to defer behind.
  assert.equal(shouldDeferSmallFollowUpCompaction(false, 8, 90_000, LCM_DEFER), false)
})

test("hard context pressure overrides the small-batch deferral", () => {
  assert.equal(shouldDeferSmallFollowUpCompaction(true, 8, 114_999, LCM_DEFER), true)
  assert.equal(shouldDeferSmallFollowUpCompaction(true, 8, 115_000, LCM_DEFER), false)
})
