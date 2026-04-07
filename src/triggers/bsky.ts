import type { UserMessage } from "../types.js"

export function fromBsky(body: unknown): UserMessage {
  const b = body as Record<string, unknown>
  return {
    source: "bsky",
    triggeredAt: new Date().toISOString(),
    content: String(b.text ?? b.content ?? ""),
    raw: body,
  }
}
