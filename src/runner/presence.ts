export type RunnerPresence = "awake" | "resting"

type Listener = (presence: RunnerPresence) => void

const listeners = new Set<Listener>()
let currentPresence: RunnerPresence = "resting"

export function setRunnerPresence(presence: RunnerPresence): void {
  if (presence === currentPresence) return
  currentPresence = presence
  for (const listener of listeners) listener(presence)
}

export function subscribeRunnerPresence(listener: Listener): () => void {
  listener(currentPresence)
  listeners.add(listener)
  return () => listeners.delete(listener)
}
