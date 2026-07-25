import assert from "node:assert/strict"
import test from "node:test"
import { initDb } from "../db"
import type { Message } from "../types"
import {
  archiveContextMessages,
  batchActiveContextSummariesForPrompt,
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

test("context grep bounds large recursive tool results while retaining expansion metadata", () => {
  const marker = `bounded-search-${Date.now()}`
  const message = { role: "tool", content: `${marker}\n${"nested result ".repeat(1_000)}` } as Message
  archiveContextMessages([message], "test-large-tool-result")

  const result = grepContext(marker, 1)[0]
  assert.ok(result)
  assert.equal(result.contentTruncated, true)
  assert.equal(result.contentChars, String(message.content).length)
  assert.ok(result.content.length < result.contentChars)
  assert.match(result.content, /use context_expand/)
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
  assert.equal(described.summary.parentSegments[0]?.id, parentId)
  assert.equal(described.summary.parentSegments[0]?.content, "describe parent summary")
  assert.equal(described.summary.depth, 1)
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
  assert.match(String(messages[1]?.content), /\[context-summary-depth 0\]/)
})

test("model-facing context batches every active segment with the trust note and query handles", () => {
  const firstId = "sum_10000000-0000-4000-8000-000000000000"
  const secondId = "sum_20000000-0000-4000-8000-000000000000"
  const messages = [
    { role: "system", content: "bootstrap" },
    ...attachContextSummaryId([{ role: "user", content: "[context summary v1]\n[segments]\nfirst memory" } as Message], firstId, 0),
    ...attachContextSummaryId([{ role: "user", content: "[context summary v1]\n[segments]\nsecond memory" } as Message], secondId, 0),
    { role: "user", content: "fresh tail" },
  ] as Message[]

  const batched = batchActiveContextSummariesForPrompt(messages)
  assert.equal(batched.length, 3)
  assert.match(String(batched[1]?.content), /^\[continuity across time\]/)
  assert.match(String(batched[1]?.content), /these are your memories\. you lived them\./)
  assert.match(String(batched[1]?.content), new RegExp(firstId))
  assert.match(String(batched[1]?.content), new RegExp(secondId))
  assert.match(String(batched[1]?.content), /call lcm_describe/)
  assert.equal(batched[2]?.content, "fresh tail")
})

test("summary DAG records ordered multi-parent consolidation nodes", () => {
  const childIds = ["one", "two", "three", "four"].map((label) => recordContextCompaction({
    summaryText: `${label} leaf summary`,
    compactedMessages: [{ role: "user", content: `${label} exact source` } as Message],
    method: "test-lcm-leaf",
  }))
  const parentId = recordContextCompaction({
    summaryText: "four-way merged memory",
    compactedMessages: [],
    parentSummaryIds: childIds,
    method: "test-lcm-merge-d1",
  })

  const described = describeContextSummary(parentId)
  assert.ok(described)
  assert.deepEqual(described.summary.parentIds, childIds)
  assert.equal(described.summary.depth, 1)
  assert.equal(described.summary.parentSegments.length, 4)
  assert.equal(expandContextSummary(parentId)?.totalMessages, 4)
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

test("rest snapshot preserves active segments and archives the exact raw tail as a new leaf", () => {
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

  assert.equal(snapshot.summaryIds[0], parentId)
  assert.equal(snapshot.forests[0], parentForest)
  assert.equal(snapshot.summaryIds.length, 2)
  const tailSummaryId = snapshot.summaryIds[1]!
  assert.equal(contextSummaryId(snapshot.forests[1]!), tailSummaryId)
  const expanded = expandContextSummary(tailSummaryId, 0, 10)
  assert.ok(expanded)
  assert.deepEqual(
    expanded.messages.map((message) => (message.content as { content: string }).content),
    [preSummaryWake.content, tail[0]?.content, tail[1]?.content],
  )
  assert.equal(expandContextSummary(parentId)?.messages[0]?.content &&
    (expandContextSummary(parentId)!.messages[0]!.content as { content: string }).content, oldSource.content)
})

test("rest snapshot creates a recoverable summary before the first compaction", () => {
  const raw = { role: "user", content: `never compacted ${Date.now()}` } as Message
  const snapshot = recordRestContextSnapshot([
    { role: "system", content: "bootstrap" },
    raw,
  ] as Message[])

  assert.match(snapshot.forests[0]!, /^\[context summary v1\]/)
  assert.equal(contextSummaryId(snapshot.forests[0]!), snapshot.summaryIds[0])
  assert.equal(expandContextSummary(snapshot.summaryIds[0]!)?.totalMessages, 1)
})
