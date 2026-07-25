import { buildBootstrap } from "../bootstrap"
import { clientTools } from "../client"
import { areDiscordToolsAvailable } from "../discord/availability"
import { markDiscordItem } from "../discord/state"
import { endConversation, logMessage, startConversation } from "../db"
import { emit } from "../stream"
import { runLoop } from "./loop"
import { setRunnerPresence } from "./presence"
import { createNiriToolCatalog } from "./tool-catalog"
import { archiveContextMessages, normalizeActiveContextSummaryDepths } from "./context-store"
import type { RunnerStateInternal } from "./types"
import { clearSession, loadRestSnapshot, loadSession, saveRestSnapshot, saveSession } from "./util"
import type { UserMessage } from "../types"
import { getMcpToolDefinitions } from "../mcp"

let eventResolvers: Array<(event: UserMessage | null) => void> = []
let shutdownResolvers: Array<() => void> = []
const PROCESS_STARTED_AT = new Date().toISOString()

function currentToolCatalog() {
  return [
    ...createNiriToolCatalog({
      clientCapabilities: clientTools.getCapabilities(),
      workspace: clientTools.getWorkspace(),
      memory: true,
      discord: areDiscordToolsAvailable(),
    }),
    ...getMcpToolDefinitions(),
  ]
}

const state: RunnerStateInternal = {
  contextSize: 0,
  running: false,
  conversation: [],
  pendingInputs: [],
  tokenCount: 0,
  toolInFlight: false,
  memoryRecallCooldowns: {},
  memoryRecallTurn: 0,
  memoryRecallPending: false,
  shutdownRequested: false,
  turnInFlight: false,
  deferredEvents: [],
}

/**
 * Returns whether a runner session is currently active.
 *
 * @returns `true` when the wake loop is running, otherwise `false`.
 */
export function isRunning(): boolean {
  return state.running
}

/** Returns whether the runner is persisting state for a process shutdown. */
export function isShuttingDown(): boolean {
  return state.shutdownRequested
}

/** Returns whether the runner is currently blocked in wait or wait_then_continue. */
export function isWaitingForEvent(): boolean {
  return eventResolvers.length > 0
}

export function getRunnerStatus(): {
  running: boolean
  idle: boolean
  tokenCount: number
  contextSize: number
  processStartedAt: string
  uptimeMs: number
} {
  return {
    running: state.running,
    idle: isWaitingForEvent(),
    tokenCount: state.tokenCount,
    contextSize: state.contextSize,
    processStartedAt: PROCESS_STARTED_AT,
    uptimeMs: Math.max(0, Date.now() - new Date(PROCESS_STARTED_AT).getTime()),
  }
}

type EnqueueOptions = {
  onlyIfWaiting?: boolean
  priority?: boolean
}

/** Push an event into the live session, resolving the loop's wait if it's idle. */
function deliverEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.shutdownRequested) {
    console.log("[runner] dropping event during shutdown from", event.source)
    return false
  }

  if (options.onlyIfWaiting && eventResolvers.length === 0) {
    return false
  }

  console.log("[runner] queued event from", event.source)
  if (state.toolInFlight) {
    // Defer external steering until the currently running tool settles.
    const deferred = { event, priority: Boolean(options.priority) }
    if (options.priority) {
      state.deferredEvents.unshift(deferred)
    } else {
      state.deferredEvents.push(deferred)
    }
    return true
  }

  // Never push directly into conversation as the loop adds the user message at
  // waitForEvent() time, which is only reached when no tool calls are in flight.
  const resolver = eventResolvers.shift()
  if (resolver) {
    resolver(event)
  } else {
    if (options.priority) {
      state.pendingInputs.unshift(event)
    } else {
      state.pendingInputs.push(event)
    }
  }
  return true
}

function flushDeferredEvents(): void {
  if (state.toolInFlight || state.deferredEvents.length === 0) return
  const events = state.deferredEvents
  state.deferredEvents = []
  for (const { event, priority } of events) {
    deliverEvent(event, { priority })
  }
}

/**
 * Enqueues an event for the active session, or stores it for the next wake cycle.
 * `onlyIfWaiting` rejects the event unless a wait resolver is active.
 *
 * @param event - Trigger event to deliver to the runner.
 * @returns `true` when the event was accepted for delivery.
 */
export function enqueueEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.running) {
    return deliverEvent(event, options)
  }
  if (options.onlyIfWaiting) {
    return false
  }
  if (options.priority) {
    state.pendingInputs.unshift(event)
  } else {
    state.pendingInputs.push(event)
  }
  return true
}

/**
 * Persists the active runner state for a process shutdown.
 *
 * Resolves immediately if no session is currently running.
 *
 * @returns A promise that resolves when shutdown persistence has completed.
 */
export async function shutdown(): Promise<void> {
  if (!state.running || state.conversation.length === 0) return

  state.shutdownRequested = true
  interruptEventWaiters()
  if (state.turnInFlight || state.toolInFlight) {
    await new Promise<void>((resolve) => {
      shutdownResolvers.push(resolve)
    })
    return
  }

  await saveRuntimeSnapshot()
}

function interruptEventWaiters(): void {
  const resolvers = eventResolvers
  eventResolvers = []
  for (const resolve of resolvers) resolve(null)
}

function resolveShutdown(): void {
  const resolvers = shutdownResolvers
  shutdownResolvers = []
  for (const resolve of resolvers) resolve()
}

async function saveRuntimeSnapshot(): Promise<void> {
  archiveContextMessages(state.conversation, "runtime-checkpoint")
  await saveSession(state.conversation)
  await saveRestSnapshot(state.conversation, "runtime checkpoint")
}

/** Wait until the next event arrives (or return immediately if one is pending). */
function waitForEvent(): Promise<UserMessage | null> {
  if (state.shutdownRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) {
    return Promise.resolve(state.pendingInputs.shift()!)
  }
  return new Promise<UserMessage | null>((resolve) => {
    eventResolvers.push(resolve)
  })
}

/** Wait up to timeoutMs for the next event; resolves null if the timer fires first. */
function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
  if (state.shutdownRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) {
    return Promise.resolve(state.pendingInputs.shift()!)
  }
  return new Promise<UserMessage | null>((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const idx = eventResolvers.indexOf(resolver)
      if (idx !== -1) eventResolvers.splice(idx, 1)
      resolve(null)
    }, timeoutMs)

    const resolver = (event: UserMessage | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(event)
    }

    eventResolvers.push(resolver)
  })
}

function formatIncomingEvent(event: UserMessage): string {
  return `[incoming — ${event.source}]\n\n${event.content}`
}

function autoSeeDiscordEvent(event: UserMessage): void {
  if (event.source !== "discord") return

  const match = event.content.match(/^source_item_id:\s*(\S+)/m)
  const itemId = match?.[1]?.trim()
  if (!itemId) return

  try {
    markDiscordItem(itemId, "seen", "auto-seen after injection into runner context", "noted")
  } catch (err) {
    console.warn(`[runner] failed to auto-see Discord item ${itemId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function emitUserEvent(event: UserMessage): void {
  emit({
    type: "user",
    source: event.source,
    text: event.content,
    triggeredAt: event.triggeredAt,
    clientId: event.clientId,
  })
}

function injectIncomingEvent(convId: number, event: UserMessage): void {
  autoSeeDiscordEvent(event)
  const incomingMessage = formatIncomingEvent(event)
  state.conversation.push({
    role: "user",
    content: incomingMessage,
  })
  logMessage(convId, "user", incomingMessage)
  emitUserEvent(event)
  // A new incoming event starts a new turn — recall once for it.
  state.memoryRecallPending = true
  console.log("[runner] injected event from", event.source)
}

/**
 * Starts the runner loop for an incoming trigger event.
 *
 * If a session is already active, the event is queued instead of starting a new loop.
 *
 * @param event - Event that should wake or steer the runner.
 * @returns A promise that resolves once this wake cycle fully completes.
 */
export async function wake(event: UserMessage): Promise<void> {
  if (state.running) {
    enqueueEvent(event)
    return
  }

  state.running = true
  setRunnerPresence("awake")
  state.tokenCount = 0
  state.contextSize = 0
  state.memoryRecallCooldowns = {}
  state.memoryRecallTurn = 0
  // The wake event is the first turn — recall once for it.
  state.memoryRecallPending = true

  const saved = await loadSession()
  if (saved) {
    state.conversation = normalizeActiveContextSummaryDepths(saved)
    autoSeeDiscordEvent(event)
    state.conversation.push({
      role: "user",
      content: `[harness restarted — ${event.source} @ ${event.triggeredAt}]\n\n${event.content}`,
    })
  } else {
    autoSeeDiscordEvent(event)
    state.conversation = normalizeActiveContextSummaryDepths(await buildBootstrap(event, await loadRestSnapshot(), {
      clientCapabilities: clientTools.getCapabilities(),
      workspace: clientTools.getWorkspace(),
      discord: areDiscordToolsAvailable(),
    }))
  }

  const convId = startConversation(event.source, event.triggeredAt)

  const wakeMsg = state.conversation[state.conversation.length - 1]
  if (wakeMsg && wakeMsg.role === "user") {
    logMessage(convId, "user", typeof wakeMsg.content === "string" ? wakeMsg.content : JSON.stringify(wakeMsg.content))
    emitUserEvent(event)
  }

  console.log("[runner] niri is awake")

  try {
    const exit = await runLoop(convId, state, {
      clientTools,
      getTools: currentToolCatalog,
      waitForEvent,
      waitForEventWithTimeout,
      injectIncomingEvent,
      flushDeferredEvents,
      clearSession,
      saveSession: saveRuntimeSnapshot,
      saveShutdownSnapshot: saveRuntimeSnapshot,
      shouldShutdown: () => state.shutdownRequested,
      resolveShutdown,
    })
    if (exit === "rest") setRunnerPresence("resting")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[runner] loop aborted: ${message}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    try {
      await saveRuntimeSnapshot()
    } catch (saveErr) {
      console.warn(`[runner] failed to persist session after abort: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`)
    }
  } finally {
    const wasShutdownRequested = state.shutdownRequested
    endConversation(convId, state.tokenCount)
    state.running = false
    state.conversation = []
    state.toolInFlight = false
    state.memoryRecallCooldowns = {}
    state.memoryRecallTurn = 0
    state.memoryRecallPending = false
    state.shutdownRequested = false
    state.turnInFlight = false
    if (!wasShutdownRequested) flushDeferredEvents()
    state.deferredEvents = []
    eventResolvers = []
    resolveShutdown()
    setRunnerPresence("resting")
    console.log("[runner] niri is resting")

    if (!wasShutdownRequested && state.pendingInputs.length > 0) {
      const next = state.pendingInputs.shift()!
      console.log("[runner] pending event queued, waking again")
      await wake(next)
    }
  }
}
