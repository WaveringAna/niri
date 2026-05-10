import type { UserMessage } from "../types"

export function fromChat(body: unknown): UserMessage {
  const b = body as Record<string, unknown>
  return {
    source: "chat",
    triggeredAt: new Date().toISOString(),
    content: String(b.content ?? ""),
    raw: body,
    clientId: typeof b.clientId === "string" ? b.clientId : undefined,
  }
}
