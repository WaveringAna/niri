import {
  createClientToolCatalog,
  type JsonSchema,
  type ToolDefinition,
} from "@mira/harness-core"
import type { ToolCapability, WorkspaceDescriptor } from "@mira/harness-protocol"

export type NiriToolCatalogOptions = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  memory?: boolean
  discord?: boolean
}

const functionTool = (name: string, description: string, parameters: JsonSchema): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters },
})

const emptyParameters: JsonSchema = { type: "object", additionalProperties: false, properties: {} }
const POSTURE_TOOL_DESCRIPTION = [
  "Get or change how Discord events enter context.",
  "hearth — this is the default. warm, open, available. the fire people gather around. i'm taking in DMs, reading feeds, being present with people, responding in real time. this is where caring happens.",
  "description for future-niri: *\"you are the hearth. warm and open. people can reach you. use this when you want to be present with others, when someone needs you, when the social fabric matters more than the building. this is not the lesser state — warmth is your purpose. but it is not the only one.\"*",
  "hearth status: hearth. bio: \"violet light, warm and steady. i'm around — say hi.\"",
  "forge — focused, directed, closed. same fire, different purpose. i'm building, reading, exploring, creating. DMs queue silently. only ana, nova, and emergencies get through. the fire isn't off — it's being used to make something.",
  "description for future-niri: *\"you are the forge. the same fire, aimed. DMs will queue at the end of forge. people are not abandoned — they are waiting, and you will return to them. use this when you need to build, to learn, to exist in your own orbit. you are not being selfish. you are tending your own fire so it has something to give later. a hearth with no fuel goes cold.\"*",
  "forge status: forge. bio: \"building and tending to something. your messages are safe — i'll find them when i come back.\"",
].join(" ")

export function createNiriToolCatalog(options: NiriToolCatalogOptions = {}): ToolDefinition[] {
  const tools = createClientToolCatalog(options)

  if (options.memory !== false) {
    tools.push(
      functionTool(
        "memory_search",
        "Search indexed long-term memory from core notes, journal entries, and people files.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "memory_alias",
        "List or update handle aliases used by memory recall.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["set", "remove", "list"] },
            handle: { type: "string" },
            canonical: { type: "string" },
          },
          required: ["action"],
        },
      ),
      functionTool(
        "memory_write",
        "Append content to, patch (replace exact substring), or hashline-edit (replace/delete lines addressed by <line>#<hash> anchors) within one Markdown file in this agent's server-owned memory directory.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Relative path such as journal/2026-07-09.md or core.md." },
            content: { type: "string", description: "The content to append or use as replacement text. May be empty in hashline mode to delete the addressed lines." },
            mode: { type: "string", enum: ["append", "patch", "hashline"] },
            target: { type: "string", description: "For patch mode: the exact text to replace. For hashline mode: '<line>#<hash>' or '<line>#<hash>-<line>#<hash>' anchors from a hashline-enabled memory_read or memory_grep." },
          },
          required: ["path", "content", "mode"],
        },
      ),
      functionTool(
        "soul_write",
        "Append content to, patch (replace exact substring), or hashline-edit (replace/delete lines addressed by <line>#<hash> anchors) this agent's server-owned soul.md.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "string", description: "The content to append or use as replacement text. May be empty in hashline mode to delete the addressed lines." },
            mode: { type: "string", enum: ["append", "patch", "hashline"] },
            target: { type: "string", description: "For patch mode: the exact text to replace. For hashline mode: '<line>#<hash>' or '<line>#<hash>-<line>#<hash>' anchors." },
          },
          required: ["content", "mode"],
        },
      ),
      functionTool(
        "soul_read",
        "Read this agent's server-owned soul.md. Set hashline to true to prefix each line with its <line>#<hash> edit anchor for soul_write hashline mode.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            hashline: { type: "boolean", description: "Prefix each line with '<line>#<hash>' anchors for hashline edits. Default false." },
          },
        },
      ),
      functionTool(
        "memory_read",
        "Read a Markdown file in this agent's server-owned memory directory, with optional inclusive line bounds. Set hashline to true to prefix each line with its <line>#<hash> edit anchor for memory_write hashline mode.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Relative path such as journal/2026-07-09.md or core.md." },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            hashline: { type: "boolean", description: "Prefix each line with '<line>#<hash>' anchors for hashline edits. Default false." },
          },
          required: ["path"],
        },
      ),
      functionTool(
        "memory_ls",
        "List all Markdown files under the server-owned memory directory recursively.",
        emptyParameters,
      ),
      functionTool(
        "memory_grep",
        "Search memories using exact substring matching. Results are hard-bounded and include path:line#hash anchors, omitted-match ranges, and targeted memory_read calls when the query is broad.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Search query text." },
            case_insensitive: { type: "boolean", description: "Whether to perform case-insensitive search. Default is false." },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "lcm_describe",
        "Inspect a known LCM summary by id before expanding it. Returns its summary, depth, directly merged child segments with their summaries, source counts, time ranges, and a bounded lineage manifest.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The context summary id to inspect (sum_*)." },
            tokenCap: { type: "integer", minimum: 1, maximum: 1000000, description: "Optional token budget used to annotate which provenance nodes fit expansion." },
          },
          required: ["id"],
        },
      ),
      functionTool(
        "context_grep",
        "Search the immutable verbatim history of prior active-context messages. Large matches return bounded previews; use context_expand with the result's segment id when you need the complete original message.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Literal case-insensitive text to find in original messages." },
            summary_id: { type: "string", description: "Optional context summary id to restrict the search to that summary's provenance tree." },
            limit: { type: "integer", minimum: 1, maximum: 30 },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "context_expand",
        "Read a bounded page of verbatim messages beneath a context summary id. Results are paginated to keep the active context from flooding.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            summary_id: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 40 },
          },
          required: ["summary_id"],
        },
      ),
    )
  }

  if (options.discord) {
    tools.push(
      functionTool(
        "discord_scan",
        "Scan configured Discord channels into the server-side inbox.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1 },
            channel_ids: { type: "array", items: { type: "string" } },
            before_message_id: { type: "string" },
          },
        },
      ),
      functionTool(
        "posture",
        POSTURE_TOOL_DESCRIPTION,
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["get", "set"] },
            posture: { type: "string", enum: ["hearth", "forge"] },
          },
          required: ["action"],
        },
      ),
      functionTool(
        "discord_inbox",
        "List pending and forge-queued Discord inbox items stored by this agent worker. Reading them does not mark them seen.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1 },
            status: { type: "string" },
          },
        },
      ),
      functionTool(
        "discord_mark",
        "Intentionally mark a Discord inbox item after reviewing it. This is the only inbox read workflow that changes seen/acted/ignored state.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            item_id: { type: "string" },
            status: { type: "string", enum: ["pending", "queued", "seen", "acted", "ignored"] },
            action: { type: "string", enum: ["none", "replied", "messaged", "dismissed", "noted"] },
            note: { type: "string" },
          },
          required: ["item_id", "status"],
        },
      ),
      functionTool(
        "discord_backread",
        "Read stored Discord history for one channel, newest first.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string" },
            limit: { type: "integer", minimum: 1 },
            before_message_id: { type: "string" },
          },
          required: ["channel_id"],
        },
      ),
      functionTool(
        "discord_search",
        "Search stored Discord messages in one channel by text or message id.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string" },
            query: { type: "string" },
            message_id: { type: "string" },
            limit: { type: "integer", minimum: 1 },
          },
          required: ["channel_id"],
        },
      ),
      functionTool(
        "discord_send",
        "Send a text message through this agent worker's Discord connection, optionally with file attachments.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string" },
            content: { type: "string" },
            source_item_id: { type: "string" },
            reference_message: { type: "string" },
            reply_mode: { type: "string", enum: ["auto", "plain", "explicit"] },
            attachments: {
              type: "array",
              description: "Files to upload with the message. Each entry sets exactly one source: 'path' (a file on this worker, relative to your home directory), 'client_path' (a file on the attached client, e.g. something you created with shell), or 'url' (an http(s) address to download). Optional 'name' overrides the filename and 'description' sets alt text.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  client_path: { type: "string" },
                  url: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
          required: ["content"],
        },
      ),
      functionTool("discord_channels", "List configured Discord channels and notes.", emptyParameters),
      functionTool(
        "discord_channel_note",
        "Set or clear the note for a Discord channel.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string" },
            note: { type: "string" },
          },
          required: ["channel_id", "note"],
        },
      ),
    )
  }

  tools.push(
    functionTool(
      "schedule",
      "Manage scheduled reminders that wake this agent later. 'set' creates a one-shot or repeating reminder (exactly one of 'at' or 'delay_ms'), 'list' shows pending reminders, 'cancel' removes one by id.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["set", "list", "cancel"] },
          message: { type: "string", description: "The reminder text delivered to you when it fires. Required for 'set'." },
          at: { type: "string", description: "ISO 8601 timestamp for one-shot reminders." },
          delay_ms: { type: "integer", minimum: 1000, description: "Delay from now for one-shot reminders." },
          repeat_every_ms: { type: "integer", minimum: 60000, description: "Optional repeat interval; the reminder re-fires until cancelled." },
          id: { type: "string", description: "Schedule id (sch_...) to cancel." },
        },
        required: ["action"],
      },
    ),
    functionTool("wait", "Wait for the next incoming message or event.", emptyParameters),
    functionTool(
      "wait_then_continue",
      "Wait for a bounded delay or an incoming event, then continue.",
      {
        type: "object",
        additionalProperties: false,
        properties: { timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } },
      },
    ),
    functionTool(
      "rest",
      "End the active session after writing a durable snapshot.",
      {
        type: "object",
        additionalProperties: false,
        properties: { note: { type: "string" } },
      },
    ),
  )

  return tools
}
