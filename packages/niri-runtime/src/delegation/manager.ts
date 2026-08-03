import { endConversation, startConversation } from "../db"
import type { UserMessage } from "../types"
import { delegationConfig, findDelegationProfile, type DelegationProfile } from "./config"
import {
  appendDelegatedTaskMessage,
  createDelegatedTask,
  getDelegatedTask,
  getDelegatedTaskByThread,
  interruptActiveDelegatedTasks,
  listDelegatedTaskMessages,
  listDelegatedTasks,
  listQueuedDelegatedTasks,
  updateDelegatedTask,
  type DelegatedMessageKind,
  type DelegatedTask,
  type DelegatedTaskMessage,
} from "./store"

type DeliverMain = (event: UserMessage, options?: { priority?: boolean }) => void

export type DelegationMirror = {
  createThread(task: DelegatedTask): Promise<string | null>
  postMessage(task: DelegatedTask, message: DelegatedTaskMessage): Promise<void>
  updateStatus(task: DelegatedTask): Promise<void>
  threadUrl(threadId: string): string
}

type ActiveTask = {
  cancelled: boolean
  profile: DelegationProfile
}

let deliverMain: DeliverMain | null = null
let mirror: DelegationMirror | null = null
let initialized = false
let stopping = false
const activeTasks = new Map<string, ActiveTask>()
const inputWaiters = new Map<string, Set<() => void>>()
const threadCreationPromises = new Map<string, Promise<void>>()

function deliverToMain(content: string, task: DelegatedTask, priority = false): void {
  deliverMain?.({
    source: "delegation",
    triggeredAt: new Date().toISOString(),
    content,
    raw: { taskId: task.id, profile: task.profile, discordThreadId: task.discordThreadId },
  }, { priority })
}

function wakeInputWaiters(taskId: string): void {
  const waiters = inputWaiters.get(taskId)
  if (!waiters) return
  inputWaiters.delete(taskId)
  for (const resolve of waiters) resolve()
}

function hasCollaboratorInputAfter(taskId: string, afterSeq: number): boolean {
  return listDelegatedTaskMessages(taskId, { afterSeq, limit: 100 }).some((message) => message.senderKind !== "subagent" && message.kind !== "system")
}

async function waitForInput(taskId: string, afterSeq: number, timeoutMs: number): Promise<void> {
  const task = getDelegatedTask(taskId)
  if (!task || task.cancelRequested || hasCollaboratorInputAfter(taskId, afterSeq)) return
  await new Promise<void>((resolve) => {
    const waiters = inputWaiters.get(taskId) ?? new Set<() => void>()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(finish)
      if (waiters.size === 0 && inputWaiters.get(taskId) === waiters) inputWaiters.delete(taskId)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(1, timeoutMs))
    timer.unref?.()
    waiters.add(finish)
    inputWaiters.set(taskId, waiters)
    if (hasCollaboratorInputAfter(taskId, afterSeq)) wakeInputWaiters(taskId)
  })
}

async function mirrorMessage(taskId: string, message: DelegatedTaskMessage): Promise<void> {
  if (!mirror) return
  let task = getDelegatedTask(taskId)
  if (task && !task.discordThreadId) {
    await ensureDiscordThread(taskId)
    task = getDelegatedTask(taskId)
  }
  if (!task?.discordThreadId) return
  await mirror.postMessage(task, message).catch((err) => {
    console.warn(`[delegation] failed to mirror message ${message.id}: ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function ensureDiscordThread(taskId: string): Promise<void> {
  const currentMirror = mirror
  if (!currentMirror) return
  const existing = threadCreationPromises.get(taskId)
  if (existing) return existing

  const creation = (async () => {
    const task = getDelegatedTask(taskId)
    if (!task || task.discordThreadId) return
    const threadId = await currentMirror.createThread(task).catch((err) => {
      console.warn(`[delegation] failed to create Gastown thread for ${task.id}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    if (threadId) updateDelegatedTask(task.id, { discordThreadId: threadId })
  })()
  threadCreationPromises.set(taskId, creation)
  try {
    await creation
  } finally {
    if (threadCreationPromises.get(taskId) === creation) threadCreationPromises.delete(taskId)
  }
}

async function updateMirrorStatus(taskId: string): Promise<void> {
  if (!mirror) return
  await ensureDiscordThread(taskId)
  const task = getDelegatedTask(taskId)
  if (!task?.discordThreadId) return
  await mirror.updateStatus(task).catch((err) => {
    console.warn(`[delegation] failed to mirror status for ${task.id}: ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function publishWorkerMessage(taskId: string, kind: Extract<DelegatedMessageKind, "progress" | "question" | "result">, content: string): Promise<void> {
  const taskBefore = getDelegatedTask(taskId)
  if (!taskBefore) throw new Error(`unknown task ${taskId}`)
  const message = appendDelegatedTaskMessage({
    taskId,
    senderKind: "subagent",
    senderName: taskBefore.profile,
    kind,
    content,
  })
  if (kind === "question") updateDelegatedTask(taskId, { status: "needs_input" })
  if (kind === "question") {
    const task = getDelegatedTask(taskId) ?? taskBefore
    const thread = task.discordThreadId && mirror ? `\nthread: ${mirror.threadUrl(task.discordThreadId)}` : ""
    deliverToMain(`[delegated task needs input]\ntask_id: ${task.id}\nworker: ${task.profile}\n\n${content}${thread}`, task, true)
  }
  await mirrorMessage(taskId, message)
  if (kind === "question") await updateMirrorStatus(taskId)
}

function activeWriterExists(): boolean {
  return [...activeTasks.values()].some((active) => active.profile.tools.includes("edit_file"))
}

function nextRunnableTask(): { task: DelegatedTask; profile: DelegationProfile } | null {
  const writerActive = activeWriterExists()
  for (const task of listQueuedDelegatedTasks()) {
    const profile = findDelegationProfile(task.profile)
    if (!profile) {
      updateDelegatedTask(task.id, { status: "failed", completedAt: new Date().toISOString(), error: `profile ${task.profile} is no longer configured` })
      continue
    }
    if (profile.tools.includes("edit_file") && writerActive) continue
    return { task, profile }
  }
  return null
}

function truncateResult(result: string): string {
  if (result.length <= delegationConfig.resultMaxChars) return result
  return `${result.slice(0, delegationConfig.resultMaxChars)}\n\n…[truncated; use delegate action=read for the durable task transcript]`
}

async function runTask(task: DelegatedTask, profile: DelegationProfile): Promise<void> {
  const active: ActiveTask = { cancelled: false, profile }
  activeTasks.set(task.id, active)
  updateDelegatedTask(task.id, { status: "running", startedAt: new Date().toISOString() })
  const convId = startConversation(`delegation:${profile.name}`, new Date().toISOString())
  console.log(`[delegation] ${task.id} started with profile ${profile.name}`)

  try {
    const { runDelegatedSubagent } = await import("./subagent.js")
    const result = await runDelegatedSubagent(convId, task, profile, {
      publish: (kind, content) => publishWorkerMessage(task.id, kind, content),
      readInbox: (afterSeq) => listDelegatedTaskMessages(task.id, { afterSeq, limit: 100 }).filter((message) => message.senderKind !== "subagent"),
      waitForInput: (afterSeq, timeoutMs) => waitForInput(task.id, afterSeq, timeoutMs),
      isCancelled: () => active.cancelled || Boolean(getDelegatedTask(task.id)?.cancelRequested),
      recordUsage: (tokenCount, contextSize) => {
        updateDelegatedTask(task.id, { tokenCount, contextSize })
      },
    }, delegationConfig.timeoutMs)
    const cancelled = active.cancelled || Boolean(getDelegatedTask(task.id)?.cancelRequested)
    const completed = updateDelegatedTask(task.id, {
      status: cancelled ? "cancelled" : "completed",
      completedAt: new Date().toISOString(),
      resultSummary: result.result,
      tokenCount: result.tokenCount,
      contextSize: result.contextSize,
    })
    endConversation(convId, result.tokenCount)
    if (completed) {
      await updateMirrorStatus(completed.id)
      if (!cancelled) {
        const thread = completed.discordThreadId && mirror ? `\nthread: ${mirror.threadUrl(completed.discordThreadId)}` : ""
        deliverToMain(
          `[delegated task completed]\ntask_id: ${completed.id}\nworker: ${completed.profile}\nusage: ${completed.tokenCount} tokens\n\n${truncateResult(result.result)}${thread}`,
          completed,
        )
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cancelled = active.cancelled || Boolean(getDelegatedTask(task.id)?.cancelRequested) || message === "task cancelled"
    const failed = updateDelegatedTask(task.id, {
      status: cancelled ? "cancelled" : "failed",
      completedAt: new Date().toISOString(),
      error: message,
    })
    endConversation(convId, getDelegatedTask(task.id)?.tokenCount ?? 0)
    if (failed) {
      const event = appendDelegatedTaskMessage({
        taskId: task.id,
        senderKind: "system",
        senderName: "gastown",
        kind: cancelled ? "cancel" : "system",
        content: cancelled ? "task cancelled" : `task failed: ${message}`,
      })
      await mirrorMessage(task.id, event)
      await updateMirrorStatus(failed.id)
      deliverToMain(
        cancelled
          ? `[delegated task cancelled]\ntask_id: ${task.id}\nworker: ${task.profile}`
          : `[delegated task failed]\ntask_id: ${task.id}\nworker: ${task.profile}\n\n${message}`,
        failed,
        !cancelled,
      )
    }
  } finally {
    activeTasks.delete(task.id)
    wakeInputWaiters(task.id)
    void pumpQueue()
  }
}

async function pumpQueue(): Promise<void> {
  if (!initialized || stopping) return
  while (activeTasks.size < delegationConfig.maxConcurrent) {
    const next = nextRunnableTask()
    if (!next) return
    void ensureDiscordThread(next.task.id)
    void runTask(next.task, next.profile)
  }
}

export function initDelegation(deliver: DeliverMain): void {
  deliverMain = deliver
  if (!delegationConfig.enabled || initialized) return
  initialized = true
  const interrupted = interruptActiveDelegatedTasks()
  if (interrupted > 0) console.warn(`[delegation] marked ${interrupted} task(s) interrupted after runtime restart`)
  if (mirror) {
    for (const task of listDelegatedTasks(100).filter((candidate) => candidate.discordThreadId && candidate.status === "interrupted")) {
      void updateMirrorStatus(task.id)
    }
  }
  void pumpQueue()
}

export function stopDelegation(): void {
  stopping = true
  for (const [taskId, active] of activeTasks) {
    active.cancelled = true
    updateDelegatedTask(taskId, { cancelRequested: true })
    wakeInputWaiters(taskId)
  }
}

export function setDelegationMirror(nextMirror: DelegationMirror | null): void {
  mirror = nextMirror
  if (!mirror || !initialized) return
  for (const task of listDelegatedTasks(100)) {
    if (!task.discordThreadId && ["queued", "running", "needs_input"].includes(task.status)) {
      void ensureDiscordThread(task.id)
    } else if (task.discordThreadId && task.status === "interrupted") {
      void updateMirrorStatus(task.id)
    }
  }
}

export function isDelegationAvailable(): boolean {
  return delegationConfig.enabled
}

export function delegationProfileNames(): string[] {
  return delegationConfig.profiles.map((profile) => profile.name)
}

export function spawnDelegatedTask(profileName: string, objective: string): DelegatedTask {
  if (!delegationConfig.enabled) throw new Error("delegation is not enabled")
  const profile = findDelegationProfile(profileName)
  if (!profile) throw new Error(`unknown delegation profile ${profileName}; available: ${delegationProfileNames().join(", ") || "none"}`)
  const task = createDelegatedTask({ profile: profile.name, objective })
  appendDelegatedTaskMessage({
    taskId: task.id,
    senderKind: "niri",
    senderName: "niri",
    kind: "instruction",
    content: objective,
  })
  void ensureDiscordThread(task.id)
  void pumpQueue()
  return task
}

export async function sendDelegatedTaskMessage(taskId: string, content: string): Promise<DelegatedTaskMessage> {
  const task = getDelegatedTask(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) throw new Error(`task ${taskId} is ${task.status}`)
  const message = appendDelegatedTaskMessage({
    taskId,
    senderKind: "niri",
    senderName: "niri",
    kind: task.status === "needs_input" ? "answer" : "instruction",
    content,
  })
  const resumed = task.status === "needs_input"
  if (resumed) {
    updateDelegatedTask(taskId, { status: "running" })
  }
  wakeInputWaiters(taskId)
  if (resumed) await updateMirrorStatus(taskId)
  await mirrorMessage(taskId, message)
  return message
}

export async function cancelDelegatedTask(taskId: string): Promise<DelegatedTask> {
  const task = getDelegatedTask(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return task
  const active = activeTasks.get(taskId)
  if (active) active.cancelled = true
  const cancelled = updateDelegatedTask(taskId, {
    status: active ? task.status : "cancelled",
    cancelRequested: true,
    ...(!active ? { completedAt: new Date().toISOString() } : {}),
  })!
  const message = appendDelegatedTaskMessage({
    taskId,
    senderKind: "niri",
    senderName: "niri",
    kind: "cancel",
    content: "task cancellation requested",
  })
  wakeInputWaiters(taskId)
  await mirrorMessage(taskId, message)
  if (!active) await updateMirrorStatus(cancelled.id)
  return cancelled
}

export type DelegatedTaskSummary = Omit<DelegatedTask, "objective" | "resultSummary" | "error"> & {
  objectivePreview: string
  hasResult: boolean
  errorPreview: string | null
}

function summarizeDelegatedTask(task: DelegatedTask): DelegatedTaskSummary {
  const { objective, resultSummary, error, ...metadata } = task
  return {
    ...metadata,
    objectivePreview: objective.length > 300 ? `${objective.slice(0, 300)}…` : objective,
    hasResult: Boolean(resultSummary),
    errorPreview: error && error.length > 500 ? `${error.slice(0, 500)}…` : error,
  }
}

export function describeDelegatedTask(taskId: string): DelegatedTaskSummary {
  const task = getDelegatedTask(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  return summarizeDelegatedTask(task)
}

export function readDelegatedTask(taskId: string, afterSeq = 0, limit = 50): { task: DelegatedTask; messages: DelegatedTaskMessage[] } {
  const task = getDelegatedTask(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  return { task, messages: listDelegatedTaskMessages(taskId, { afterSeq, limit }) }
}

export function recentDelegatedTasks(limit = 20): DelegatedTaskSummary[] {
  return listDelegatedTasks(limit).map(summarizeDelegatedTask)
}

export async function handleDiscordDelegationMessage(input: {
  threadId: string
  messageId: string
  authorId: string
  authorName: string
  content: string
  mentionsNiri: boolean
}): Promise<boolean> {
  const task = getDelegatedTaskByThread(input.threadId)
  if (!task) return false
  if (!input.content.trim()) return true
  let message: DelegatedTaskMessage
  try {
    message = appendDelegatedTaskMessage({
      taskId: task.id,
      senderKind: "discord-user",
      senderId: input.authorId,
      senderName: input.authorName,
      kind: task.status === "needs_input" ? "answer" : "instruction",
      content: input.content.trim(),
      discordMessageId: input.messageId,
    })
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) return true
    throw err
  }
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
  const resumed = task.status === "needs_input"
  if (resumed) {
    updateDelegatedTask(task.id, { status: "running" })
  }
  if (!terminal) wakeInputWaiters(task.id)
  if (terminal || input.mentionsNiri) {
    deliverToMain(
      terminal
        ? `[gastown follow-up from ${message.senderName}]\ntask_id: ${task.id}\nworker: ${task.profile}\ntask_status: ${task.status}\n\n${message.content}`
        : `[gastown message from ${message.senderName}]\ntask_id: ${task.id}\nworker: ${task.profile}\n\n${message.content}`,
      getDelegatedTask(task.id) ?? task,
      true,
    )
  }
  if (resumed) await updateMirrorStatus(task.id)
  return true
}
