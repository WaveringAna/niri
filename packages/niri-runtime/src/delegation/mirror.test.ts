import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Message } from "discord.js"

test("thread creation is deduplicated and messages wait for the mapping", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-delegation-mirror-test-"))
  process.env.NIRI_HOME = home
  process.env.NIRI_ENV = "local"
  process.env.NIRI_DELEGATION_CONFIG = JSON.stringify({
    enabled: true,
    profiles: [{ name: "researcher", tools: ["read_file"] }],
  })

  const { initDb } = await import("../db.js")
  const {
    handleDiscordDelegationMessage,
    initDelegation,
    sendDelegatedTaskMessage,
    setDelegationMirror,
    spawnDelegatedTask,
  } = await import("./manager.js")
  const { getDelegatedTask, listDelegatedTaskMessages, updateDelegatedTask } = await import("./store.js")
  initDb()

  let releaseThread: (() => void) | undefined
  const threadReady = new Promise<void>((resolve) => { releaseThread = resolve })
  let createCalls = 0
  const mirrored: string[] = []
  const statuses: string[] = []
  setDelegationMirror({
    async createThread() {
      createCalls += 1
      await threadReady
      return "thread-1"
    },
    async postMessage(_task, message) {
      mirrored.push(message.content)
    },
    async updateStatus(task) {
      statuses.push(task.status)
    },
    threadUrl: (threadId) => `https://discord.test/${threadId}`,
  })

  const task = spawnDelegatedTask("researcher", "inspect the harness")
  const send = sendDelegatedTaskMessage(task.id, "also inspect the live path")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(createCalls, 1)
  assert.deepEqual(mirrored, [])

  releaseThread?.()
  await send
  assert.equal(getDelegatedTask(task.id)?.discordThreadId, "thread-1")
  assert.deepEqual(mirrored, ["also inspect the live path"])

  updateDelegatedTask(task.id, { status: "needs_input" })
  assert.equal(await handleDiscordDelegationMessage({
    threadId: "thread-1",
    messageId: "reply-1",
    authorId: "collaborator-1",
    authorName: "callie",
    content: "yes, continue",
    mentionsNiri: false,
  }), true)
  assert.deepEqual(statuses, ["running"])

  const { __gastownTest, handleGastownMessage } = await import("../discord/gastown.js")
  const messageCount = listDelegatedTaskMessages(task.id).length
  assert.equal(await handleGastownMessage({
    author: { bot: true },
    webhookId: null,
    channelId: "thread-1",
  } as unknown as Message), true)
  assert.equal(listDelegatedTaskMessages(task.id).length, messageCount)

  const forumRequest = __gastownTest.forumThreadRequest("forum-1", getDelegatedTask(task.id)!)
  assert.equal(forumRequest.route, "/channels/forum-1/threads")
  assert.equal(forumRequest.body.name, "[researcher] inspect the harness")
  assert.equal(forumRequest.body.auto_archive_duration, 1440)
  assert.match(forumRequest.body.message.content, /every human member of this private server is equally authorized/)

  updateDelegatedTask(task.id, { status: "interrupted" })
  initDelegation(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(statuses, ["running", "interrupted"])
  assert.match(__gastownTest.forumThreadRequest("forum-1", getDelegatedTask(task.id)!).body.name, /^\[interrupted\]/)
})
