import OpenAI from "openai"
import { AGENT_ID } from "../agent-config"
import { writeMemory, writeSoul } from "../agent-state-tools"
import { logMessage } from "../db"
import {
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
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
import type { LoopHooks } from "./types"

const DEFAULT_WAIT_THEN_CONTINUE_MS = 10_000
const MAX_TOOL_TIMEOUT_MS = 10 * 60_000
const IMAGE_MIME_SIGNATURES: Record<string, (data: Buffer) => boolean> = {
  "image/png": (data) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (data) => data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9,
  "image/gif": (data) => data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")),
  "image/webp": (data) => data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP",
  "image/bmp": (data) => data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM",
  "image/tiff": (data) => data.length >= 4 && (
    data.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    data.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ),
}

function normalizeTimeoutMs(requested: unknown, fallback: number): number {
  const numeric = Number(requested)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(Math.trunc(numeric), MAX_TOOL_TIMEOUT_MS)
}

function validateClientImage(image: { mime: string; bytes: number; dataUrl: string }, maxBytes: number): void {
  const prefix = `data:${image.mime};base64,`
  if (!image.dataUrl.startsWith(prefix)) throw new Error("client returned an invalid image data URL")
  const encoded = image.dataUrl.slice(prefix.length)
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("client returned invalid base64 image data")
  }
  const data = Buffer.from(encoded, "base64")
  if (data.length !== image.bytes) throw new Error(`client image byte count mismatch (${image.bytes} claimed, ${data.length} decoded)`)
  if (data.length > maxBytes) throw new Error(`image exceeds server safety limit (${data.length} > ${maxBytes} bytes)`)
  const validSignature = IMAGE_MIME_SIGNATURES[image.mime]
  if (!validSignature || !validSignature(data)) throw new Error(`client image bytes do not match ${image.mime}`)
}

async function executeClientText(
  hooks: Pick<LoopHooks, "clientTools">,
  ctx: Parameters<ToolHandler>[0],
  tool: "shell" | "read_file" | "edit_file",
): Promise<string> {
  const result = await hooks.clientTools.execute({
    agentId: AGENT_ID,
    tool,
    args: ctx.args,
    timeoutMs: typeof ctx.args.timeout_ms === "number" ? ctx.args.timeout_ms : undefined,
  })
  if (result.status !== "ok") return result.output || `error: client ${tool} result is ${result.status}`
  return result.output ?? ""
}

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

export function buildToolHandlers(hooks: Pick<LoopHooks, "clientTools">): Record<string, ToolHandler> {
  return {
    wait_then_continue: async ({ convId, state, hooks, call, args }) => {
      const timeoutMs = normalizeTimeoutMs(args.timeout_ms, DEFAULT_WAIT_THEN_CONTINUE_MS)
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
      if (hooks.shouldShutdown()) {
        console.log("[runner] wait_then_continue: interrupted by shutdown")
        return {}
      }
      console.log(`[runner] wait_then_continue: timeout elapsed, continuing to next turn`)
      return {}
    },

    wait: async ({ convId, state, hooks, call, args }) => {
      recordToolResult(convId, state, call, "wait", args, "Waiting for next event.")
      console.log("[runner] niri is waiting for next event...")
      const incoming = await hooks.waitForEvent()
      if (!incoming) {
        console.log("[runner] wait interrupted by shutdown")
        return {}
      }
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
        runArgKeys: [] as const,
        run: () => executeClientText(hooks, ctx, "shell"),
        emptyFallback: "(no output)",
      }),

    read_file: (ctx) =>
      runStandardTool(ctx, {
        name: "read_file",
        logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        runArgKeys: [] as const,
        run: () => executeClientText(hooks, ctx, "read_file"),
        emptyFallback: "(empty file)",
      }),

    edit_file: (ctx) =>
      runStandardTool(ctx, {
        name: "edit_file",
        logArgKeys: ["path", "timeout_ms"] as const,
        runArgKeys: [] as const,
        run: () => executeClientText(hooks, ctx, "edit_file"),
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

    memory_write: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_write",
        logArgKeys: ["path", "mode"] as const,
        runArgKeys: ["path", "content", "mode"] as const,
        run: (filePath, content, mode) => writeMemory(filePath, content, mode),
        emitArgKeys: ["path", "mode"] as const,
        previewChars: 0,
      }),

    soul_write: (ctx) =>
      runStandardTool(ctx, {
        name: "soul_write",
        logArgKeys: [] as const,
        runArgKeys: ["content"] as const,
        run: (content) => writeSoul(content),
        previewChars: 0,
      }),

    image_tool: async ({ convId, state, call, args }) => {
      console.log("[image_tool]", args.path, args.timeout_ms)
      let result: string

      try {
        const detail = parseImageDetail(args.detail)
        const clientResult = await hooks.clientTools.execute({
          agentId: AGENT_ID,
          tool: "image_tool",
          args,
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        })
        if (clientResult.status !== "ok" || !clientResult.image) {
          throw new Error(clientResult.output || `client image_tool result is ${clientResult.status}`)
        }
        const image = clientResult.image
        const maxImageBytes = Math.max(1, Number.parseInt(process.env.IMAGE_TOOL_MAX_BYTES ?? "1000000", 10) || 1_000_000)
        validateClientImage(image, maxImageBytes)
        const note =
          typeof args.note === "string" && args.note.trim()
            ? args.note.trim()
            : `Please inspect this image: ${image.path}`

        result = pushToolMessage(convId, state, call, `attached ${image.path} (${image.mime}, ${image.bytes} bytes from client)`)

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

    discord_send: (ctx) => {
      const targetError = validateNoChannelDiscordSendTarget(ctx.state, ctx.args.channel_id, ctx.args.source_item_id)
      if (targetError) {
        recordToolResult(ctx.convId, ctx.state, ctx.call, "discord_send", { _invalid_target: true }, targetError)
        return Promise.resolve({})
      }

      return runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["channel_id", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "source_item_id", "reply_mode", "reference_message"] as const,
        run: async (channel_id, content, source_item_id, reply_mode, reference_message) => {
          const result = await sendDiscordMessage({
            channelId: channel_id as string,
            content: content as string,
            sourceItemId: source_item_id as string | undefined,
            replyMode: reply_mode as string | undefined,
            referenceMessage: reference_message as string | undefined,
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
  validateClientImage,
  validateNoChannelDiscordSendTarget,
}
