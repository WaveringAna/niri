import assert from "node:assert/strict"
import test from "node:test"
import { initDb } from "../db"
import type { Message } from "../types"
import {
  archiveContextMessages,
  attachContextSummaryId,
  contextSummaryId,
  expandContextSummary,
  grepContext,
  recordContextCompaction,
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
