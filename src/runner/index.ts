import { buildBootstrap } from "../bootstrap"
import { endConversation, logMessage, startConversation } from "../db"
import { emit } from "../stream"
import { runLoop } from "./loop"
import { setRunnerPresence } from "./presence"
import type { RunnerStateInternal } from "./types"
import { clearSession, loadSession, saveSession } from "./util"
import type { UserMessage } from "../types"

let eventResolvers: Array<(event: UserMessage) => void> = []
let shutdownResolve: (() => void) | null = null

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

/** Returns whether the runner is currently blocked in wait or wait_then_continue. */
export function isWaitingForEvent(): boolean {
  return eventResolvers.length > 0
}

type EnqueueOptions = {
  onlyIfWaiting?: boolean
  priority?: boolean
}

/** Push an event into the live session, resolving the loop's wait if it's idle. */
function deliverEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
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
 * Requests graceful shutdown by injecting a final chat event and waiting for rest.
 *
 * Resolves immediately if no session is currently running.
 *
 * @returns A promise that resolves when shutdown handling has completed.
 */
export function shutdown(): Promise<void> {
  if (!state.running) return Promise.resolve()

  return new Promise<void>((resolve) => {
    if (!state.running) {
      resolve()
      return
    }
    shutdownResolve = resolve
    deliverEvent({
      source: "chat",
      content: "hey, the harness is shutting down. please journal this session and rest 💙",
      triggeredAt: new Date().toISOString(),
      raw: {},
    })
  })
}

/** Wait until the next event arrives (or return immediately if one is pending). */
function waitForEvent(): Promise<UserMessage> {
  if (state.pendingInputs.length > 0) {
    return Promise.resolve(state.pendingInputs.shift()!)
  }
  return new Promise<UserMessage>((resolve) => {
    eventResolvers.push(resolve)
  })
}

/** Wait up to timeoutMs for the next event; resolves null if the timer fires first. */
function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
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

    const resolver = (event: UserMessage) => {
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
    state.conversation = saved
    state.conversation.push({
      role: "user",
      content: `[harness restarted — ${event.source} @ ${event.triggeredAt}]\n\n${event.content}`,
    })
  } else {
    state.conversation = await buildBootstrap(event)
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
      waitForEvent,
      waitForEventWithTimeout,
      injectIncomingEvent,
      flushDeferredEvents,
      clearSession,
      saveSession: async () => saveSession(state.conversation),
    })
    if (exit === "rest") setRunnerPresence("resting")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[runner] loop aborted: ${message}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    try {
      await saveSession(state.conversation)
    } catch (saveErr) {
      console.warn(`[runner] failed to persist session after abort: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`)
    }
  } finally {
    endConversation(convId, state.tokenCount)
    state.running = false
    state.conversation = []
    state.toolInFlight = false
    state.memoryRecallCooldowns = {}
    state.memoryRecallTurn = 0
    state.memoryRecallPending = false
    flushDeferredEvents()
    state.deferredEvents = []
    eventResolvers = []
    setRunnerPresence("resting")
    console.log("[runner] niri is resting")
    shutdownResolve?.()
    shutdownResolve = null

    if (state.pendingInputs.length > 0) {
      const next = state.pendingInputs.shift()!
      console.log("[runner] pending event queued, waking again")
      await wake(next)
    }
  }
}
