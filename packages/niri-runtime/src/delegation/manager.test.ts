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

  const Database = (await import("better-sqlite3")).default
  const legacyDb = new Database(path.join(home, "niri.db"))
  legacyDb.exec(`
    create table delegated_tasks (
      id text primary key,
      profile text not null,
      objective text not null,
      status text not null,
      created_by_kind text not null,
      created_by_id text,
      created_by_name text,
      created_at text not null,
      started_at text,
      completed_at text,
      result_summary text,
      error text,
      discord_thread_id text unique,
      cancel_requested integer not null default 0,
      token_count integer not null default 0,
      context_size integer not null default 0
    )
  `)
  legacyDb.close()

  const { initDb } = await import("../db.js")
  const {
    appendDelegatedTaskMessage,
    createDelegatedTask,
    listDelegationProfileFeedback,
    listDelegatedTaskMessages,
    updateDelegatedTask,
  } = await import("./store.js")
  const {
    __delegationManagerTest,
    describeDelegatedTask,
    handleDiscordDelegationMessage,
    initDelegation,
    recentDelegatedTasks,
    recordDelegatedTaskFeedback,
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

  const delivered: Array<{ content: string; priority: boolean | undefined }> = []
  initDelegation((event, options) => delivered.push({ content: event.content, priority: options?.priority }))
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
  assert.match(delivered[0]?.content ?? "", /gastown follow-up from callie/)
  assert.match(delivered[0]?.content ?? "", /task_status: completed/)

  const progressTask = createDelegatedTask({ profile: "researcher", objective: "inspect the docs" })
  updateDelegatedTask(progressTask.id, { status: "running" })
  await __delegationManagerTest.publishWorkerMessage(progressTask.id, "progress", "checking the official docs")
  assert.equal(delivered.length, 2)
  assert.match(delivered[1]?.content ?? "", /\[delegated task progress\]/)
  assert.match(delivered[1]?.content ?? "", new RegExp(progressTask.id))
  assert.match(delivered[1]?.content ?? "", /checking the official docs/)
  assert.equal(delivered[1]?.priority, false)

  const feedback = await recordDelegatedTaskFeedback(task.id, "when asked for progress, report it before the result")
  assert.equal(feedback.profile, "researcher")
  assert.equal(feedback.taskId, task.id)
  assert.deepEqual(listDelegationProfileFeedback("researcher").map((item) => item.content), [
    "when asked for progress, report it before the result",
  ])
  assert.equal(listDelegatedTaskMessages(task.id).at(-1)?.kind, "feedback")

  const nextTask = createDelegatedTask({ profile: "researcher", objective: "inspect another source" })
  const { __delegationSubagentTest } = await import("./subagent.js")
  const prompt = __delegationSubagentTest.taskSystemPrompt(nextTask, {
    name: "researcher",
    systemPrompt: "inspect first",
    tools: ["read_file"],
    mcpTools: [],
    maxTurns: 30,
  })
  assert.match(prompt, /niri's durable feedback/)
  assert.match(prompt, /when asked for progress, report it before the result/)
  assert.match(prompt, new RegExp(task.id))

  const verbose = createDelegatedTask({ profile: "researcher", objective: "o".repeat(500) })
  updateDelegatedTask(verbose.id, {
    resultSummary: "r".repeat(1000),
    error: "e".repeat(1000),
    cacheReadTokens: 120,
    uncachedInputTokens: 30,
    outputTokens: 7,
  })
  const status = describeDelegatedTask(verbose.id)
  assert.equal("objective" in status, false)
  assert.equal("resultSummary" in status, false)
  assert.equal("error" in status, false)
  assert.equal(status.objectivePreview.length, 301)
  assert.equal(status.hasResult, true)
  assert.equal(status.errorPreview?.length, 501)
  assert.equal(status.cacheReadTokens, 120)
  assert.equal(status.uncachedInputTokens, 30)
  assert.equal(status.outputTokens, 7)
  assert.equal("tokenCount" in status, false)
  assert.equal("contextSize" in status, false)
  assert.ok(recentDelegatedTasks().every((entry) => !("resultSummary" in entry)))
})
