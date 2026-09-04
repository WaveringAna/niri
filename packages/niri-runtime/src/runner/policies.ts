import type { Message } from "@mira/agent-context"
import type { TurnPolicy } from "@mira/agent-loop"
import { assistantContentText } from "./loop-content"

/**
 * Niri's turn policies.
 *
 * The discord_send nudge used to live inside the core loop, which meant every
 * agent built on this harness inherited Discord-specific behavior. It is a
 * policy now: Niri registers it, nobody else does.
 */

/**
 * Detects when the assistant responded to a Discord message with
 * conversational text but did not call discord_send. Injects a system
 * nudge so the next turn actually delivers the message.
 */
function isDiscordInputMessage(message: Message): boolean {
  return message.role === "user" && typeof message.content === "string" && /\[discord(?:\/(?:dm|channel)| batch)\]/i.test(message.content)
}

function activeUserTurnMessages(conversation: Message[], turnMessages: Message[]): Message[] {
  // Prefer a user event injected during this model/tool step. Otherwise walk
  // back to the latest user message in the full conversation. This keeps the
  // original input active across preliminary assistant/tool steps such as
  // memory_read on a fresh wake.
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    if (turnMessages[i]?.role === "user") return turnMessages.slice(i)
  }
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]?.role === "user") return conversation.slice(i)
  }
  return turnMessages
}

function hasDiscordInputForTurn(conversation: Message[], turnMessages: Message[]): boolean {
  return activeUserTurnMessages(conversation, turnMessages).some(isDiscordInputMessage)
}

function discordSendNudge(
  conversation: Message[],
  turnMessages: Message[],
): string | null {
  // Check the whole active user turn, including preliminary tool calls made
  // after a fresh wake and before the assistant writes its reply.
  const activeTurnMessages = activeUserTurnMessages(conversation, turnMessages)
  const hasDiscordInput = activeTurnMessages.some(isDiscordInputMessage)
  if (!hasDiscordInput) return null

  // A discord_send from an earlier assistant/tool step in the same user turn
  // means the reply was already delivered.
  const hasDiscordSend = activeTurnMessages.some(
    (m) =>
      m.role === "assistant" &&
      "tool_calls" in m &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === "function" && tc.function.name === "discord_send"),
  )
  if (hasDiscordSend) return null

  // Also check if a tool result from discord_send exists (edge case: tool result is separate message)
  const hasDiscordSendResult = activeTurnMessages.some(
    (m) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.includes('"ok":true') &&
      m.content.includes("discord_send"),
  )
  if (hasDiscordSendResult) return null

  // Find the assistant's text content in this turn
  const assistantText = turnMessages.find((m) => m.role === "assistant" && assistantContentText(m.content).length > 0)
  if (!assistantText) return null

  // The assistant wrote something in response to a Discord message but
  // never actually sent it. Nudge.
  return "[system] you wrote a response to a Discord message but did not call discord_send. your message was not delivered. call discord_send now or explicitly decide not to reply."
}

/**
 * Niri writes a reply to a Discord message "in her head" and then calls
 * wait/rest without ever delivering it. The model believes it replied; the
 * person sees silence. Detect that and make her finish the job.
 */
export const discordSendPolicy: TurnPolicy = {
  name: "discord-send",
  onTurnEnd({ state, turnMessages }) {
    const nudge = discordSendNudge(state.conversation, turnMessages)
    if (nudge) {
      console.warn("[runner] discord_send nudge: assistant responded to Discord input without calling discord_send")
    }
    return nudge
  },
}

export const niriTurnPolicies: TurnPolicy[] = [discordSendPolicy]

export const __policyTest = { discordSendNudge, hasDiscordInputForTurn }
