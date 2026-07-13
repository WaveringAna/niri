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
        "Append content to or patch (replace exact substring) within one Markdown file in this agent's server-owned memory directory.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Relative path such as journal/2026-07-09.md or core.md." },
            content: { type: "string", description: "The content to append or use as replacement text." },
            mode: { type: "string", enum: ["append", "patch"] },
            target: { type: "string", description: "Only required when mode is 'patch'. The exact text sequence in the file to be replaced." },
          },
          required: ["path", "content", "mode"],
        },
      ),
      functionTool(
        "soul_write",
        "Append content to or patch (replace exact substring) this agent's server-owned soul.md.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "string", description: "The content to append or use as replacement text." },
            mode: { type: "string", enum: ["append", "patch"] },
            target: { type: "string", description: "Only required when mode is 'patch'. The exact text sequence in the file to be replaced." },
          },
          required: ["content", "mode"],
        },
      ),
      functionTool(
        "memory_read",
        "Read a Markdown file in this agent's server-owned memory directory, with optional inclusive line bounds.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Relative path such as journal/2026-07-09.md or core.md." },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
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
        "Search memories using exact substring matching, returning matching lines and numbers.",
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
        "context_grep",
        "Search the immutable verbatim history of prior active-context messages. Use this when a compacted summary may have omitted a useful detail.",
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
        "discord_inbox",
        "List pending Discord inbox items stored by this agent worker.",
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
        "Send a text message through this agent worker's Discord connection.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string" },
            content: { type: "string" },
            source_item_id: { type: "string" },
            reference_message: { type: "string" },
            reply_mode: { type: "string", enum: ["auto", "plain", "explicit"] },
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
