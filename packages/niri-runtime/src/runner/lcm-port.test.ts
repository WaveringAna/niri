import assert from "node:assert/strict"
import test from "node:test"
import { createLcmEngine, type ConversationCompaction, type SummarizerModel, type SummaryCircuit } from "@mira/agent-context"
import { initDb } from "../db"
import type { Message } from "../types"
import { contextArchive } from "./archive"
import { niriSummaryPrompts } from "./summary-prompts"

initDb()

/**
 * Written against `runner/lcm-compaction.ts` and kept verbatim against
 * `@mira/agent-context`'s engine, which it was ported into.
 */
const archive = contextArchive()
const activeContextSummaries = archive.activeContextSummaries
const contextSummaryMessage = archive.contextSummaryMessage
const describeContextSummary = archive.describe
const expandContextSummary = archive.expand
const recordContextCompaction = archive.recordCompaction
const lcm = createLcmEngine({ archive, agentName: "niri", batchSize: 4 })

const noopCircuit: SummaryCircuit = {
  isOpen: () => false,
  recordFailure() {},
  recordUnusable() {},
  recordSuccess() {},
}

/** Stands in for the summary model; returns a fixed, plausible summary. */
function fakeModel(text: string): SummarizerModel {
  return { id: "test\nsummary-model", model: "summary-model", completeText: async () => text }
}

test("four depth-zero segments remain visible, then a fifth promotes the oldest four", async () => {
  const existing = ["one", "two", "three"].map((label) => {
    const id = recordContextCompaction({
      summaryText: `${label} independent memory segment with concrete feelings, actions, and details`,
      compactedMessages: [{ role: "user", content: `${label} exact source` } as Message],
      method: "test-lcm-leaf",
    })
    return contextSummaryMessage(`${label} independent memory segment with concrete feelings, actions, and details`, id, 0)
  })
  const fourthSource = { role: "user", content: "four exact source" } as Message
  const placeholder = {
    role: "user",
    content: "[context summary v1]\n[segments]\n[llm-summary now]\nfour independent memory segment with concrete feelings, actions, and details",
  } as Message
  const compaction: ConversationCompaction = {
    messages: [{ role: "system", content: "bootstrap" }, ...existing, placeholder],
    summaryText: "four independent memory segment with concrete feelings, actions, and details",
    summaryContent: String(placeholder.content),
    compactedMessages: [fourthSource],
  }
  const summaryModel = fakeModel(
    "I remember all four connected periods: their concrete actions, feelings, relationships, unfinished threads, grief, joy, and the exact details that made each one mine.",
  )

  const fourth = await lcm.commitLcmCompaction(compaction, summaryModel, noopCircuit, niriSummaryPrompts, "test-lcm-leaf")
  const fourActive = activeContextSummaries(fourth.messages)
  assert.equal(fourActive.length, 4)
  assert.deepEqual(fourActive.map((summary) => summary.depth), [0, 0, 0, 0])
  assert.equal(fourth.mergedSummaryIds.length, 0)

  const fifthSource = { role: "user", content: "five exact source" } as Message
  const fifthPlaceholder = {
    role: "user",
    content: "[context summary v1]\n[segments]\nfive independent memory segment with concrete feelings, actions, and details",
  } as Message
  const fifth = await lcm.commitLcmCompaction({
    messages: [...fourth.messages, fifthPlaceholder],
    summaryText: "five independent memory segment with concrete feelings, actions, and details",
    summaryContent: String(fifthPlaceholder.content),
    compactedMessages: [fifthSource],
  }, summaryModel, noopCircuit, niriSummaryPrompts, "test-lcm-leaf")
  const active = activeContextSummaries(fifth.messages)

  assert.equal(active.length, 2)
  assert.deepEqual(active.map((summary) => summary.depth), [1, 0])
  assert.equal(fifth.mergedSummaryIds.length, 1)
  const described = describeContextSummary(active[0]!.id)
  assert.ok(described)
  assert.equal(described.summary.parentIds.length, 4)
  assert.equal(described.summary.parentSegments.length, 4)
  assert.equal(expandContextSummary(active[0]!.id)?.totalMessages, 4)
})

test("context pressure cascades complete same-depth batches into higher DAG levels", async () => {
  const makeLeaf = (label: string) => recordContextCompaction({
    summaryText: `${label} memory with concrete feelings, actions, people, identifiers, and unfinished threads`,
    compactedMessages: [{ role: "user", content: `${label} exact source` } as Message],
    method: "test-cascade-leaf",
  })
  const depthOneMessages = Array.from({ length: 3 }, (_, group) => {
    const children = Array.from({ length: 4 }, (_, child) => makeLeaf(`group-${group}-child-${child}`))
    const id = recordContextCompaction({
      summaryText: `group ${group} merged memory with concrete feelings, actions, people, identifiers, and unfinished threads`,
      compactedMessages: [],
      parentSummaryIds: children,
      method: "test-cascade-d1",
    })
    return contextSummaryMessage(`group ${group} merged memory with concrete feelings, actions, people, identifiers, and unfinished threads`, id, 1)
  })
  const depthZeroMessages = Array.from({ length: 4 }, (_, index) => {
    const id = makeLeaf(`latest-${index}`)
    return contextSummaryMessage(`latest ${index} memory with concrete feelings, actions, people, identifiers, and unfinished threads`, id, 0)
  })
  const summaryModel = fakeModel("I retain every safety-critical event, feeling, relationship, action, identifier, and unfinished thread across all four periods without flattening what made each period matter.")

  const consolidated = await lcm.consolidateLcmFrontier(
    [{ role: "system", content: "bootstrap" }, ...depthOneMessages, ...depthZeroMessages],
    summaryModel,
    noopCircuit,
    niriSummaryPrompts,
  )
  const active = activeContextSummaries(consolidated.messages)

  assert.equal(consolidated.mergedSummaryIds.length, 2)
  assert.equal(active.length, 1)
  assert.equal(active[0]?.depth, 2)
  const described = describeContextSummary(active[0]!.id)
  assert.ok(described)
  assert.equal(described.summary.parentIds.length, 4)
  assert.equal(described.summary.depth, 2)
  assert.equal(expandContextSummary(active[0]!.id)?.totalMessages, 16)
})
