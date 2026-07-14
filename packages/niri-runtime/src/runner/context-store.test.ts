import assert from "node:assert/strict"
import test from "node:test"
import { initDb } from "../db"
import type { Message } from "../types"
import {
  archiveContextMessages,
  attachContextSummaryId,
  contextSummaryId,
  describeContextSummary,
  expandContextSummary,
  grepContext,
  recordContextCompaction,
  recordRestContextSnapshot,
} from "./context-store"

initDb()

test("immutable context archive preserves exact messages and supports literal search", () => {
  const marker = `lossless-search-${Date.now()}`
  const message = { role: "user", content: `the exact hidden detail is ${marker}` } as Message

  const [messageId] = archiveContextMessages([message], "test-checkpoint")
  const results = grepContext(marker, 5)

  assert.ok(messageId?.startsWith("msg_"))
  assert.equal(results.length, 1)
  assert.equal(results[0]?.messageId, messageId)
  assert.equal(results[0]?.content, message.content)
  assert.equal(results[0]?.source, "test-checkpoint")
})

test("summary DAG expands parent provenance before newer direct messages", () => {
  const first = { role: "user", content: "first exact source message" } as Message
  const second = { role: "assistant", content: "second exact source message" } as Message
  const third = { role: "user", content: "third exact source message" } as Message

  const parentId = recordContextCompaction({
    summaryText: "parent summary",
    compactedMessages: [first, second],
    method: "test-parent",
  })
  const parentContent = `[context summary v1]\n[segments]\n[context-summary-id ${parentId}]\nparent summary`
  const childId = recordContextCompaction({
    summaryText: "child summary",
    compactedMessages: [third],
    priorSummaryContent: parentContent,
    method: "test-child",
  })

  const expanded = expandContextSummary(childId, 0, 10)
  assert.ok(expanded)
  assert.equal(expanded.totalMessages, 3)
  assert.deepEqual(
    expanded.messages.map((message) => (message.content as { content: string }).content),
    [first.content, second.content, third.content],
  )

  const scoped = grepContext("first exact", 5, childId)
  assert.equal(scoped.length, 1)
})

test("lcm description exposes summary content, lineage, and bounded expansion costs", () => {
  const parentMessage = { role: "user", content: "describe parent source" } as Message
  const childMessage = { role: "assistant", content: "describe child source" } as Message
  const parentId = recordContextCompaction({
    summaryText: "describe parent summary",
    compactedMessages: [parentMessage],
    method: "test-describe-parent",
  })
  const parentContent = `[context summary v1]\n[segments]\n[context-summary-id ${parentId}]\ndescribe parent summary`
  const childId = recordContextCompaction({
    summaryText: "describe child summary",
    compactedMessages: [childMessage],
    priorSummaryContent: parentContent,
    method: "test-describe-child",
  })

  const described = describeContextSummary(childId, 1)
  assert.ok(described)
  assert.equal(described.type, "summary")
  assert.equal(described.summary.content, "describe child summary")
  assert.deepEqual(described.summary.parentIds, [parentId])
  assert.equal(described.summary.provenanceDepth, 1)
  assert.equal(described.summary.provenanceNodeCount, 2)
  assert.equal(described.summary.directSources.messageCount, 1)
  assert.equal(described.summary.expandedSources.messageCount, 2)
  assert.equal(described.summary.manifest[0]?.summaryId, childId)
  assert.equal(described.summary.manifest[1]?.summaryId, parentId)
  assert.equal(described.summary.manifest[0]?.expansionFitsTokenCap, false)
  assert.equal(described.expansion.totalMessages, 2)
  assert.equal(described.expansion.defaultPageSize, 12)
  assert.equal(described.expansion.tokenCap, 1)
  assert.equal(describeContextSummary("sum_missing"), null)
})

test("active summary messages carry a stable retrievable id", () => {
  const id = "sum_00000000-0000-4000-8000-000000000000"
  const messages = attachContextSummaryId([
    { role: "system", content: "bootstrap" },
    { role: "user", content: "[context summary v1]\n[segments]\nsummary text" },
  ] as Message[], id)

  assert.equal(contextSummaryId(String(messages[1]?.content)), id)
  assert.match(String(messages[1]?.content), /\[segments\]\n\[context-summary-id/)
})

test("summary provenance preserves repeated identical message occurrences", () => {
  const repeated = { role: "user", content: `repeated exact source ${Date.now()}` } as Message
  const summaryId = recordContextCompaction({
    summaryText: "two repeated messages",
    compactedMessages: [repeated, repeated],
    method: "test-repetition",
  })

  const expanded = expandContextSummary(summaryId, 0, 10)
  assert.ok(expanded)
  assert.equal(expanded.totalMessages, 2)
  assert.equal(expanded.messages[0]?.id, expanded.messages[1]?.id)
})

test("rest snapshot extends the current summary with the exact raw tail", () => {
  const oldSource = { role: "user", content: `older compacted message ${Date.now()}` } as Message
  const parentId = recordContextCompaction({
    summaryText: "older living summary",
    compactedMessages: [oldSource],
    method: "test-before-rest",
  })
  const parentForest = String(attachContextSummaryId([
    { role: "user", content: "[context summary v1]\n[segments]\nolder living summary" } as Message,
  ], parentId)[0]?.content)
  const tail = [
    { role: "assistant", content: "recent exact tail one" } as Message,
    { role: "user", content: "recent exact tail two" } as Message,
  ]
  const preSummaryWake = { role: "user", content: "legacy wake message before summary" } as Message

  const snapshot = recordRestContextSnapshot([
    { role: "system", content: "bootstrap" },
    preSummaryWake,
    { role: "user", content: parentForest },
    ...tail,
  ] as Message[], "going to sleep")

  assert.notEqual(snapshot.summaryId, parentId)
  assert.equal(contextSummaryId(snapshot.forest), snapshot.summaryId)
  assert.doesNotMatch(snapshot.forest, new RegExp(parentId))
  const expanded = expandContextSummary(snapshot.summaryId, 0, 10)
  assert.ok(expanded)
  assert.deepEqual(
    expanded.messages.map((message) => (message.content as { content: string }).content),
    [oldSource.content, preSummaryWake.content, tail[0]?.content, tail[1]?.content],
  )
})

test("rest snapshot creates a recoverable summary before the first compaction", () => {
  const raw = { role: "user", content: `never compacted ${Date.now()}` } as Message
  const snapshot = recordRestContextSnapshot([
    { role: "system", content: "bootstrap" },
    raw,
  ] as Message[])

  assert.match(snapshot.forest, /^\[context summary v1\]/)
  assert.equal(contextSummaryId(snapshot.forest), snapshot.summaryId)
  assert.equal(expandContextSummary(snapshot.summaryId)?.totalMessages, 1)
})
