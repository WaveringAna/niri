export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "user"; text: string; source: string; triggeredAt: string; clientId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string }

export type Listener = (event: StreamEvent) => void

const listeners = new Set<Listener>()
const BUFFER_SIZE = 50
const buffer: StreamEvent[] = []

export function emit(event: StreamEvent): void {
  if (event.type === "text") console.log(`[niri] ${event.text}`)
  if (event.type === "user") console.log(`[user/${event.source}] ${event.text}`)
  buffer.push(event)
  if (buffer.length > BUFFER_SIZE) buffer.shift()
  for (const fn of listeners) fn(event)
}

export function subscribe(fn: Listener): () => void {
  for (const event of buffer) fn(event)
  listeners.add(fn)
  return () => listeners.delete(fn)
}
