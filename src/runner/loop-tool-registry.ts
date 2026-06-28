import OpenAI from "openai"
import { normalizeTimeoutMs } from "../container/config"
import { editFile, readFile, readImageForModel, runCommand } from "../container/index"
import { logMessage } from "../db"
import {
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
  markDiscordItem,
  scanDiscordChannels,
  sendDiscordMessage,
  setDiscordChannelNote,
} from "../discord/state"
import { searchDiscordMessages } from "../discord/search"
import { listAliases, removeAlias, searchMemories, setAlias } from "../memory"
import { emit } from "../stream"
import type { Message } from "../types"
import type { ToolHandler } from "./loop-shared"
import { pushToolMessage, recordToolResult, runStandardTool, toolError } from "./loop-tool-runtime"
import { parseImageDetail, saveRestSnapshot } from "./util"

const DEFAULT_WAIT_THEN_CONTINUE_MS = 10_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function messageContentText(message: Message): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const chunks: string[] = []
  for (const part of content) {
    const partRecord = asRecord(part)
    if (partRecord?.type === "text" && typeof partRecord.text === "string") chunks.push(partRecord.text)
  }
  return chunks.join("\n")
}

function isDiscordUserMessage(message: Message): boolean {
  return message.role === "user" && /\[discord(?:\/(?:dm|channel)| batch)\]|\[incoming — discord\]/i.test(messageContentText(message))
}

function isInjectedImageUserMessage(message: Message): boolean {
  const content = (message as { content?: unknown }).content
  return Array.isArray(content) && content.some((part) => asRecord(part)?.type === "image_url")
}

function isInternalUserMessage(message: Message): boolean {
  const text = messageContentText(message).trim()
  return text.startsWith("[context summary") || text.startsWith("[system]")
}

function toolNameForMessage(conversation: Message[], index: number): string | null {
  const message = conversation[index] as (Message & { tool_call_id?: unknown }) | undefined
  const toolCallId = typeof message?.tool_call_id === "string" ? message.tool_call_id : ""
  if (!toolCallId) return null

  for (let i = index - 1; i >= 0; i--) {
    const candidate = conversation[i]
    if (!candidate || candidate.role !== "assistant") continue
    const calls = (candidate as { tool_calls?: unknown }).tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const callRecord = asRecord(call)
      if (callRecord?.id !== toolCallId) continue
      const fn = asRecord(callRecord.function)
      return typeof fn?.name === "string" ? fn.name : null
    }
  }

  return null
}

function isDiscordTargetContextMessage(conversation: Message[], index: number): boolean {
  const message = conversation[index]
  if (!message) return false
  if (isDiscordUserMessage(message)) return true
  if (message.role !== "tool") return false
  return ["discord_backread", "discord_inbox"].includes(toolNameForMessage(conversation, index) ?? "")
}

function activeSourceContextStart(conversation: Message[]): number {
  let lastUser = -1
  let lastDiscordUser = -1
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i]
    if (!message || message.role !== "user") continue
    if (lastUser < 0) lastUser = i
    if (isDiscordUserMessage(message)) {
      lastDiscordUser = i
      break
    }
  }

  if (lastUser < 0) return 0
  const latestUser = conversation[lastUser]
  if (lastDiscordUser >= 0 && latestUser && (isInjectedImageUserMessage(latestUser) || isInternalUserMessage(latestUser))) {
    return lastDiscordUser
  }
  return lastUser
}

function sourceItemIdAppearsInActiveContext(conversation: Message[], sourceItemId: string): boolean {
  const safeSourceItemId = sourceItemId.trim()
  if (!safeSourceItemId) return false

  const pattern = new RegExp(`(^|\\D)${safeSourceItemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`)
  const activeStart = activeSourceContextStart(conversation)
  let targetStart = activeStart
  for (let i = conversation.length - 1; i >= activeStart; i--) {
    if (isDiscordTargetContextMessage(conversation, i)) {
      targetStart = i
      break
    }
  }

  const activeMessages = conversation.slice(targetStart)
  return activeMessages.some((message) => {
    if (message.role !== "user" && message.role !== "tool") return false
    return pattern.test(messageContentText(message))
  })
}

function validateNoChannelDiscordSendTarget(state: { conversation: Message[] }, channelId: unknown, sourceItemId: unknown): string | null {
  if (typeof channelId === "string" && channelId.trim()) return null
  if (typeof sourceItemId !== "string" || !sourceItemId.trim()) return null
  if (sourceItemIdAppearsInActiveContext(state.conversation, sourceItemId)) return null
  return "error: source_item_id is not in the latest Discord target context. Use a source_item_id shown in the current Discord message, latest discord_inbox, or latest discord_backread output; otherwise provide channel_id."
}

function resultValue(result: Record<string, unknown>, key: string): string | null {
  const value = result[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function formatSentDiscordContent(content: unknown): string | null {
  if (typeof content !== "string") return null
  const normalized = content.replace(/\s+/g, " ").trim()
  return normalized || null
}

function formatDiscordSendResult(result: Record<string, unknown>, content?: unknown): string {
  if (result.ok !== true) return JSON.stringify(result, null, 2)

  const parts = [
    "discord_send ok",
    resultValue(result, "sent_message_id") ? `sent_message_id=${resultValue(result, "sent_message_id")}` : null,
    resultValue(result, "channel_id") ? `channel_id=${resultValue(result, "channel_id")}` : null,
    resultValue(result, "used_reference_message_id") ? `reply_to=${resultValue(result, "used_reference_message_id")}` : null,
    resultValue(result, "resolved_source_item_id") ? `source_item_id=${resultValue(result, "resolved_source_item_id")}` : null,
  ].filter((part): part is string => Boolean(part))

  const sentContent = formatSentDiscordContent(content)
  return sentContent ? `${parts.join(" ")}\nsent: ${sentContent}` : parts.join(" ")
}

/**
 * Builds the function-tool handler table for the runner loop.
 *
 * @returns Tool-name keyed async handler map.
 */
export function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    wait_then_continue: async ({ convId, state, hooks, call, args }) => {
      const timeoutMs = normalizeTimeoutMs(args.timeout_ms as number | undefined, DEFAULT_WAIT_THEN_CONTINUE_MS)
      recordToolResult(
        convId,
        state,
        call,
        "wait_then_continue",
        args,
        `Waiting up to ${timeoutMs}ms for an event or timeout, then continuing.`,
      )
      console.log(`[runner] wait_then_continue: waiting up to ${timeoutMs}ms...`)
      const event = await hooks.waitForEventWithTimeout(timeoutMs)
      if (event) {
        console.log(`[runner] wait_then_continue: interrupted early by incoming ${event.source} event`)
        hooks.injectIncomingEvent(convId, event)
        return { isWait: true }
      }
      console.log(`[runner] wait_then_continue: timeout elapsed, continuing to next turn`)
      return {}
    },

    wait: async ({ convId, state, hooks, call, args }) => {
      recordToolResult(convId, state, call, "wait", args, "Waiting for next event.")
      console.log("[runner] niri is waiting for next event...")
      const incoming = await hooks.waitForEvent()
      hooks.injectIncomingEvent(convId, incoming)
      return { isWait: true }
    },

    rest: async ({ convId, state, hooks, call, args }) => {
      if (args.note) console.log("[runner] rest note:", args.note)
      recordToolResult(convId, state, call, "rest", args, "Goodnight.")
      await saveRestSnapshot(state.conversation, args.note as string | undefined)
      await hooks.clearSession()
      return { shouldRest: true }
    },

    shell: (ctx) =>
      runStandardTool(ctx, {
        name: "shell",
        logArgKeys: ["command", "timeout_ms"] as const,
        runArgKeys: ["command", "max_lines", "timeout_ms"] as const,
        run: (command, max_lines, timeout_ms) =>
          runCommand(command as string, max_lines as number | undefined, timeout_ms as number | undefined),
        emptyFallback: "(no output)",
      }),

    read_file: (ctx) =>
      runStandardTool(ctx, {
        name: "read_file",
        logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        runArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        run: (path, start_line, end_line, timeout_ms) =>
          readFile(path as string, start_line as number | undefined, end_line as number | undefined, timeout_ms as number | undefined),
        emptyFallback: "(empty file)",
      }),

    edit_file: (ctx) =>
      runStandardTool(ctx, {
        name: "edit_file",
        logArgKeys: ["path", "timeout_ms"] as const,
        runArgKeys: ["path", "old_text", "new_text", "timeout_ms"] as const,
        run: async (path, old_text, new_text, timeout_ms) => {
          const editResult = await editFile(
            path as string,
            old_text as string,
            new_text as string,
            timeout_ms as number | undefined,
          )
          return editResult.ok ? editResult.message : `error: ${editResult.message}`
        },
        emitArgKeys: ["path"] as const,
        previewChars: 0,
      }),

    memory_search: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_search",
        logArgKeys: ["query", "limit"] as const,
        runArgKeys: ["query", "limit"] as const,
        run: async (query, limit) =>
          JSON.stringify(
            {
              query,
              results: await searchMemories(query as string, limit as number | undefined),
            },
            null,
            2,
          ),
        emptyFallback: '{"query":"","results":[]}',
      }),

    memory_alias: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_alias",
        logArgKeys: ["action", "handle", "canonical"] as const,
        runArgKeys: ["action", "handle", "canonical"] as const,
        run: async (action, handle, canonical) => {
          const op = String(action ?? "").toLowerCase()
          if (op === "list") {
            return JSON.stringify({ ok: true, aliases: await listAliases() }, null, 2)
          }
          if (op === "set") {
            if (!handle || !canonical) {
              return JSON.stringify({ ok: false, error: "set requires handle and canonical" })
            }
            const map = await setAlias(String(handle), String(canonical))
            return JSON.stringify({ ok: true, aliases: map }, null, 2)
          }
          if (op === "remove") {
            if (!handle) return JSON.stringify({ ok: false, error: "remove requires handle" })
            const map = await removeAlias(String(handle), canonical ? String(canonical) : undefined)
            return JSON.stringify({ ok: true, aliases: map }, null, 2)
          }
          return JSON.stringify({ ok: false, error: `unknown action: ${op}` })
        },
      }),

    image_tool: async ({ convId, state, call, args }) => {
      console.log("[image_tool]", args.path, args.timeout_ms)
      let result: string

      try {
        const detail = parseImageDetail(args.detail)
        const image = await readImageForModel(args.path as string, args.timeout_ms as number | undefined)
        const note =
          typeof args.note === "string" && args.note.trim()
            ? args.note.trim()
            : `Please inspect this image: ${image.path}`

        result = pushToolMessage(convId, state, call, `attached ${image.path} (${image.mime}, ${image.bytes} bytes)`)

        const imageMessage: OpenAI.Chat.ChatCompletionUserMessageParam = {
          role: "user",
          content: [
            { type: "text", text: note },
            { type: "image_url", image_url: { url: image.dataUrl, detail } },
          ],
        }
        state.conversation.push(imageMessage)
        logMessage(convId, "user", `[image_tool] ${note}\npath=${image.path}\ndetail=${detail}`)
      } catch (err) {
        result = recordToolResult(convId, state, call, "image_tool", { path: args.path, detail: args.detail }, toolError(err))
        return {}
      }

      emit({ type: "tool", name: "image_tool", args: { path: args.path, detail: args.detail }, result })
      return {}
    },

    discord_scan: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_scan",
        logArgKeys: ["limit", "before_message_id"] as const,
        runArgKeys: ["limit", "channel_ids", "before_message_id"] as const,
        run: async (limit, channel_ids, before_message_id) =>
          JSON.stringify(
            await scanDiscordChannels({
              limit: limit as number | undefined,
              channelIds: channel_ids as string[] | string | undefined,
              beforeMessageId: before_message_id as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_inbox: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_inbox",
        logArgKeys: ["limit", "status"] as const,
        runArgKeys: ["limit", "status"] as const,
        run: async (limit, status) =>
          JSON.stringify(
            listDiscordInbox(limit as number | undefined, status as string | string[] | undefined),
            null,
            2,
          ),
      }),

    discord_backread: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_backread",
        logArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        runArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        run: async (channel_id, limit, before_message_id) =>
          JSON.stringify(
            listDiscordBackread(
              channel_id as string,
              limit as number | undefined,
              before_message_id as string | undefined,
            ),
            null,
            2,
          ),
      }),

    discord_search: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_search",
        logArgKeys: ["channel_id", "query", "message_id", "limit"] as const,
        runArgKeys: ["channel_id", "query", "message_id", "limit"] as const,
        run: async (channel_id, query, message_id, limit) =>
          JSON.stringify(
            await searchDiscordMessages({
              channelId: channel_id as string,
              query: query as string | undefined,
              messageId: message_id as string | undefined,
              limit: limit as number | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_mark: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_mark",
        logArgKeys: ["item_id", "status", "action"] as const,
        runArgKeys: ["item_id", "status", "note", "action"] as const,
        run: async (item_id, status, note, action) => {
          markDiscordItem(
            item_id as string,
            status as "pending" | "seen" | "acted" | "ignored",
            (note as string | undefined) ?? "",
            (action as "none" | "replied" | "messaged" | "dismissed" | "noted" | undefined) ?? "none",
          )
          return JSON.stringify(
            {
              ok: true,
              item_id,
              status,
              action: action ?? "none",
              note: note ?? "",
            },
            null,
            2,
          )
        },
      }),

    discord_send: (ctx) => {
      const targetError = validateNoChannelDiscordSendTarget(ctx.state, ctx.args.channel_id, ctx.args.source_item_id)
      if (targetError) {
        recordToolResult(ctx.convId, ctx.state, ctx.call, "discord_send", { _invalid_target: true }, targetError)
        return Promise.resolve({})
      }

      return runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["channel_id", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "source_item_id", "reply_mode", "reference_message", "attachments"] as const,
        run: async (channel_id, content, source_item_id, reply_mode, reference_message, attachments) => {
          const result = await sendDiscordMessage({
            channelId: channel_id as string,
            content: content as string,
            sourceItemId: source_item_id as string | undefined,
            replyMode: reply_mode as string | undefined,
            referenceMessage: reference_message as string | undefined,
            attachments: attachments as Array<{ path: string; name?: string; description?: string }> | undefined,
          })
          return formatDiscordSendResult(result, content)
        },
      })
    },

    discord_channels: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channels",
        logArgKeys: [] as const,
        runArgKeys: [] as const,
        run: async () => JSON.stringify(listDiscordChannels(), null, 2),
      }),

    discord_channel_note: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channel_note",
        logArgKeys: ["channel_id"] as const,
        runArgKeys: ["channel_id", "note"] as const,
        run: async (channel_id, note) =>
          JSON.stringify(setDiscordChannelNote(channel_id as string, (note as string | undefined) ?? ""), null, 2),
      }),
  }
}

export const __toolRegistryTest = {
  formatDiscordSendResult,
  validateNoChannelDiscordSendTarget,
}
