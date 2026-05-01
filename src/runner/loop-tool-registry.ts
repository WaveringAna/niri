import OpenAI from "openai"
import { normalizeTimeoutMs } from "../container/config.js"
import { editFile, readFile, readImageForModel, runCommand } from "../container/index.js"
import { logMessage } from "../db.js"
import {
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
  markDiscordItem,
  scanDiscordChannels,
  sendDiscordMessage,
  setDiscordChannelNote,
} from "../discord/state.js"
import { listAliases, removeAlias, searchMemories, setAlias } from "../memory.js"
import { emit } from "../stream.js"
import type { ToolHandler } from "./loop-shared.js"
import { pushToolMessage, recordToolResult, runStandardTool, toolError } from "./loop-tool-runtime.js"
import { parseImageDetail } from "./util.js"

const DEFAULT_WAIT_THEN_CONTINUE_MS = 10_000

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

    discord_send: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["channel_id", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "source_item_id", "reply_mode", "reference_message"] as const,
        run: async (channel_id, content, source_item_id, reply_mode, reference_message) =>
          JSON.stringify(
            await sendDiscordMessage({
              channelId: channel_id as string,
              content: content as string,
              sourceItemId: source_item_id as string | undefined,
              replyMode: reply_mode as string | undefined,
              referenceMessage: reference_message as string | undefined,
            }),
            null,
            2,
          ),
      }),

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
