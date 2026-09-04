import type { ToolDefinition } from "@mira/harness-core"
import type { ToolHandler, ToolModule, ToolModuleContext } from "@mira/agent-loop"
import type { ToolCapability, WorkspaceDescriptor } from "@mira/harness-protocol"
import { clientTools } from "../client"
import { areDiscordToolsAvailable } from "../discord/availability"
import { delegationProfileNames, isDelegationAvailable } from "../delegation/manager"
import { getMcpToolDefinitions, hasMcpTool, callMcpTool } from "../mcp"
import { buildToolHandlers } from "./loop-tool-registry"
import { createNiriToolCatalog, modelFacingClientCapabilities } from "./tool-catalog"

/**
 * Niri's tool surface, grouped into `ToolModule`s.
 *
 * The schemas still come from `createNiriToolCatalog` and the bodies still come
 * from `buildToolHandlers`; this file only draws the boundaries between them.
 * Duplicating either would mean maintaining two copies of ~800 lines, and the
 * point of the exercise is the boundary, not a rewrite.
 *
 * A different harness does not slice Niri's catalog — it writes its own modules
 * and gets none of this.
 */

/** Tools the model always has, regardless of what is attached. */
const LIFECYCLE_TOOLS = ["wait", "wait_then_continue", "rest"] as const
const WORK_TOOLS = ["work", "schedule"] as const
const WORKSPACE_TOOLS = ["python", "shell", "read_file", "write_file", "edit_file", "image_tool"] as const
/** Archive tools. These are harness-neutral and the most reusable group here. */
const CONTEXT_TOOLS = ["lcm_describe", "context_grep", "context_expand"] as const
const MEMORY_TOOLS = [
  "memory_search", "memory_alias", "memory_write", "memory_read", "memory_ls", "memory_grep",
  "soul_write", "soul_read",
] as const
const DISCORD_TOOLS = [
  "discord_scan", "discord_inbox", "discord_mark", "discord_backread", "discord_search",
  "discord_send", "discord_channels", "discord_channel_note", "posture",
] as const

type ModuleSpec = {
  name: string
  tools: readonly string[]
  /** Whether this group is live right now. */
  enabled?: () => boolean
}

function workspace(): WorkspaceDescriptor | null {
  return clientTools.getWorkspace()
}

function capabilities(): ToolCapability[] {
  return modelFacingClientCapabilities(clientTools.getCapabilities())
}

/**
 * The full catalog for the current conditions. Built once per call and sliced
 * by each module, so the conditional logic inside `createNiriToolCatalog` stays
 * the single source of truth for which tools exist.
 */
function fullCatalog(): ToolDefinition[] {
  return createNiriToolCatalog({
    clientCapabilities: capabilities(),
    workspace: workspace(),
    memory: true,
    discord: areDiscordToolsAvailable(),
    delegationProfiles: isDelegationAvailable() ? delegationProfileNames() : [],
    processJobs: Boolean(workspace()?.shellSessionResults),
  })
}

function moduleFor(spec: ModuleSpec): ToolModule {
  const owned = new Set(spec.tools)
  return {
    name: spec.name,
    definitions(_ctx: ToolModuleContext) {
      if (spec.enabled && !spec.enabled()) return []
      return fullCatalog().filter((tool) => owned.has(tool.function.name))
    },
    handlers(_ctx: ToolModuleContext) {
      if (spec.enabled && !spec.enabled()) return {}
      const all = buildToolHandlers({ clientTools })
      const picked: Record<string, ToolHandler> = {}
      for (const name of owned) {
        const handler = all[name]
        if (handler) picked[name] = handler
      }
      return picked
    },
  }
}

export const lifecycleModule = moduleFor({ name: "lifecycle", tools: LIFECYCLE_TOOLS })
export const workModule = moduleFor({ name: "work", tools: WORK_TOOLS })
export const contextModule = moduleFor({ name: "context", tools: CONTEXT_TOOLS })
export const memoryModule = moduleFor({ name: "memory", tools: MEMORY_TOOLS })
export const workspaceModule = moduleFor({ name: "workspace", tools: WORKSPACE_TOOLS })
export const discordModule = moduleFor({
  name: "discord",
  tools: DISCORD_TOOLS,
  enabled: areDiscordToolsAvailable,
})
export const delegationModule = moduleFor({
  name: "delegation",
  tools: ["delegate"],
  enabled: isDelegationAvailable,
})
export const processJobsModule = moduleFor({
  name: "process-jobs",
  tools: ["process_job"],
  enabled: () => Boolean(workspace()?.shellSessionResults),
})

/**
 * MCP tools are discovered at runtime rather than declared, so this module
 * builds its handlers from whatever is currently connected.
 */
export const mcpModule: ToolModule = {
  name: "mcp",
  definitions: () => getMcpToolDefinitions(),
  handlers() {
    const handlers: Record<string, ToolHandler> = {}
    for (const tool of getMcpToolDefinitions()) {
      const name = tool.function.name
      handlers[name] = async (ctx) => {
        if (!hasMcpTool(name)) throw new Error(`MCP tool ${name} is disconnected`)
        console.log(`[mcp tool] ${name}`)
        const result = await callMcpTool(name, ctx.args)
        const { recordToolResult } = await import("@mira/agent-loop")
        recordToolResult(ctx.runtime, ctx.convId, ctx.state, ctx.call, name, ctx.args, result)
        return {}
      }
    }
    return handlers
  },
}

/** Every module Niri runs with, in prompt order. */
export const niriToolModules: ToolModule[] = [
  workspaceModule,
  memoryModule,
  contextModule,
  workModule,
  discordModule,
  delegationModule,
  processJobsModule,
  mcpModule,
  lifecycleModule,
]
