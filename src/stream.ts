import type { StreamEvent } from "@niri/chat-client"
import { publishWorkerEvent } from "./awp/outbox"

export type { StreamEvent }

type Listener = (event: StreamEvent) => void

const listeners = new Set<Listener>()
const BUFFER_SIZE = 50
const buffer: StreamEvent[] = []
let activeConsoleText = false

function endConsoleText(): void {
  if (!activeConsoleText) return
  process.stdout.write("\n")
  activeConsoleText = false
}

export function emit(event: StreamEvent): void {
  if (event.type === "text") {
    if (!activeConsoleText) {
      process.stdout.write("[niri] ")
      activeConsoleText = true
    }
    process.stdout.write(event.text)
  } else if (event.type === "thinking") {
    if (!activeConsoleText) {
      process.stdout.write("[thinking] ")
      activeConsoleText = true
    }
    process.stdout.write(event.text)
  } else {
    endConsoleText()
    if (event.type === "user") console.log(`[user/${event.source}] ${event.text}`)
  }
  buffer.push(event)
  if (buffer.length > BUFFER_SIZE) buffer.shift()
  publishWorkerEvent("stream.event", event)
  for (const fn of listeners) fn(event)
}

export function subscribe(fn: Listener): () => void {
  for (const event of buffer) fn(event)
  listeners.add(fn)
  return () => listeners.delete(fn)
}
