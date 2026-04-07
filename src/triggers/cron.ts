import type { UserMessage } from "../types.js"

export function fromCron(): UserMessage {
  return {
    source: "cron",
    triggeredAt: new Date().toISOString(),
    content: "Scheduled heartbeat.",
    raw: null,
  }
}
