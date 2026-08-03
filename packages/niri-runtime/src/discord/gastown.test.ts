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

test("Gastown forum creation executes a webhook as the task worker", () => {
  const request = __gastownTest.webhookThreadRequest({ id: "hook-123", token: "secret-token" }, task)
  assert.equal(request.route, "/webhooks/hook-123/secret-token")
  assert.equal(request.query.get("wait"), "true")
  assert.deepEqual(request.body, {
    username: "researcher",
    avatar_url: __gastownTest.identiconUrl(task),
    thread_name: "[researcher] inspect the harness and report evidence",
    content: [
      "task: task_123",
      "status: running",
      "requested by: niri",
      "",
      "**objective**",
      "inspect the harness",
      "and report evidence",
      "",
      "every human member of this private server is equally authorized to observe and steer this task. ordinary replies go to the worker; mention niri to include her too.",
    ].join("\n"),
    allowed_mentions: { parse: [] },
  })
})

test("Gastown worker updates execute in the existing thread", () => {
  const request = __gastownTest.webhookMessageRequest(
    { id: "hook-123", token: "secret-token" },
    { ...task, discordThreadId: "thread-456" },
    "**result**\n\ndone",
  )
  assert.equal(request.route, "/webhooks/hook-123/secret-token")
  assert.equal(request.query.get("wait"), "true")
  assert.equal(request.query.get("thread_id"), "thread-456")
  assert.deepEqual(request.body, {
    username: "researcher",
    avatar_url: __gastownTest.identiconUrl(task),
    content: "**result**\n\ndone",
    allowed_mentions: { parse: [] },
  })
})

test("Gastown task identicons are deterministic and task-specific", () => {
  const url = new URL(__gastownTest.identiconUrl(task))
  assert.equal(url.hostname, "www.gravatar.com")
  assert.equal(url.searchParams.get("d"), "identicon")
  assert.equal(url.searchParams.get("f"), "y")
  assert.equal(url.searchParams.get("s"), "128")
  assert.equal(__gastownTest.identiconUrl(task), __gastownTest.identiconUrl({ ...task }))
  assert.notEqual(__gastownTest.identiconUrl(task), __gastownTest.identiconUrl({ ...task, id: "task_456" }))
})

test("Gastown mirrors split Discord messages without losing content", () => {
  const content = `${"a".repeat(1500)}\n${"b".repeat(1500)}`
  const chunks = __gastownTest.chunks(content)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 2000))
  assert.equal(chunks.join("\n"), content)
})
