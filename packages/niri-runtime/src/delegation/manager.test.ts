import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("every human in a mapped Gastown thread can steer the same task", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-gastown-test-"))
  process.env.NIRI_HOME = home
  process.env.NIRI_ENV = "local"
  process.env.NIRI_DELEGATION_CONFIG = JSON.stringify({ enabled: false, profiles: [] })

  const { initDb } = await import("../db.js")
  const {
    appendDelegatedTaskMessage,
    createDelegatedTask,
    listDelegatedTaskMessages,
    updateDelegatedTask,
  } = await import("./store.js")
  const {
    describeDelegatedTask,
    handleDiscordDelegationMessage,
    initDelegation,
    recentDelegatedTasks,
  } = await import("./manager.js")
  initDb()

  const task = createDelegatedTask({ profile: "researcher", objective: "inspect the harness" })
  appendDelegatedTaskMessage({
    taskId: task.id,
    senderKind: "niri",
    senderName: "niri",
    kind: "instruction",
    content: task.objective,
  })
  updateDelegatedTask(task.id, { status: "running", discordThreadId: "thread-1" })

  for (const collaborator of [
    { id: "user-ana", name: "ana", message: "check the live path too" },
    { id: "user-callie", name: "callie", message: "compare coral's implementation" },
  ]) {
    assert.equal(await handleDiscordDelegationMessage({
      threadId: "thread-1",
      messageId: `message-${collaborator.id}`,
      authorId: collaborator.id,
      authorName: collaborator.name,
      content: collaborator.message,
      mentionsNiri: false,
    }), true)
  }

  const messages = listDelegatedTaskMessages(task.id, { limit: 20 })
  assert.deepEqual(messages.filter((message) => message.senderKind === "discord-user").map((message) => message.senderName), ["ana", "callie"])

  assert.equal(await handleDiscordDelegationMessage({
    threadId: "thread-1",
    messageId: "message-user-ana",
    authorId: "user-ana",
    authorName: "ana",
    content: "duplicate delivery",
    mentionsNiri: false,
  }), true)
  assert.equal(listDelegatedTaskMessages(task.id, { limit: 20 }).filter((message) => message.senderKind === "discord-user").length, 2)

  const delivered: string[] = []
  initDelegation((event) => delivered.push(event.content))
  updateDelegatedTask(task.id, { status: "completed", completedAt: new Date().toISOString() })
  assert.equal(await handleDiscordDelegationMessage({
    threadId: "thread-1",
    messageId: "message-after-completion",
    authorId: "user-callie",
    authorName: "callie",
    content: "one more thing",
    mentionsNiri: false,
  }), true)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0] ?? "", /gastown follow-up from callie/)
  assert.match(delivered[0] ?? "", /task_status: completed/)

  const verbose = createDelegatedTask({ profile: "researcher", objective: "o".repeat(500) })
  updateDelegatedTask(verbose.id, { resultSummary: "r".repeat(1000), error: "e".repeat(1000) })
  const status = describeDelegatedTask(verbose.id)
  assert.equal("objective" in status, false)
  assert.equal("resultSummary" in status, false)
  assert.equal("error" in status, false)
  assert.equal(status.objectivePreview.length, 301)
  assert.equal(status.hasResult, true)
  assert.equal(status.errorPreview?.length, 501)
  assert.ok(recentDelegatedTasks().every((entry) => !("resultSummary" in entry)))
})
