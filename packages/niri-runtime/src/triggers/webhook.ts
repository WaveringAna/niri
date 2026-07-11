import type { UserMessage } from "../types"

export function fromWebhook(body: unknown): UserMessage {
  const b = body as Record<string, unknown>
  return {
    source: "webhook",
    triggeredAt: new Date().toISOString(),
    content: typeof b.content === "string" ? b.content : JSON.stringify(b),
    raw: body,
  }
}
