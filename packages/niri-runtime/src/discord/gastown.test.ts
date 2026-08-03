import assert from "node:assert/strict"
import test from "node:test"
import type { DelegatedTask } from "../delegation/store"
import { __gastownTest } from "./gastown"

const task: DelegatedTask = {
  id: "task_123",
  profile: "researcher",
  objective: "inspect the harness\nand report evidence",
  status: "running",
  createdByKind: "niri",
  createdById: null,
  createdByName: "niri",
  createdAt: "2026-08-03T00:00:00.000Z",
  startedAt: "2026-08-03T00:00:01.000Z",
  completedAt: null,
  resultSummary: null,
  error: null,
  discordThreadId: null,
  cancelRequested: false,
  tokenCount: 0,
  contextSize: 0,
}

test("Gastown forum creation uses Discord's forum-thread route and starter message", () => {
  const request = __gastownTest.forumThreadRequest("forum-123", task)
  assert.equal(request.route, "/channels/forum-123/threads")
  assert.deepEqual(request.body, {
    name: "[researcher] inspect the harness and report evidence",
    auto_archive_duration: 1440,
    message: {
      content: [
        "**researcher · task_123**",
        "status: running",
        "requested by: niri",
        "",
        "**objective**",
        "inspect the harness",
        "and report evidence",
        "",
        "every human member of this private server is equally authorized to observe and steer this task. ordinary replies go to the worker; mention niri to include her too.",
      ].join("\n"),
    },
  })
})

test("Gastown mirrors split Discord messages without losing content", () => {
  const content = `${"a".repeat(1500)}\n${"b".repeat(1500)}`
  const chunks = __gastownTest.chunks(content)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 2000))
  assert.equal(chunks.join("\n"), content)
})
