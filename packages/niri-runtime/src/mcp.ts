import { Buffer } from "node:buffer"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { JsonSchema, ToolDefinition } from "@mira/harness-core"

type McpServerConfig = {
  url?: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  auth?:
    | { type: "bearer"; token: string }
    | { type: "basic"; username: string; password: string }
}

type McpSession = {
  name: string
  client: Client
  tools: Map<string, string>
}

const sessions: McpSession[] = []
const toolDefinitions: ToolDefinition[] = []
const toolOwners = new Map<string, { session: McpSession; remoteName: string }>()

function configuredServers(): Record<string, McpServerConfig> {
  const raw = process.env.NIRI_MCP_CONFIG?.trim()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NIRI_MCP_CONFIG must be an object")
  return parsed as Record<string, McpServerConfig>
}

function publicToolName(server: string, remote: string): string {
  const normalized = `${server}__${remote}`.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (normalized.length > 64) throw new Error(`MCP tool name is longer than 64 characters: ${normalized}`)
  return normalized
}

function httpHeaders(config: McpServerConfig): Record<string, string> {
  const headers = { ...(config.headers ?? {}) }
  if (config.auth?.type === "bearer") headers.Authorization = `Bearer ${config.auth.token}`
  if (config.auth?.type === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString("base64")}`
  }
  return headers
}

function transportFor(config: McpServerConfig) {
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: httpHeaders(config) },
    })
  }
  if (!config.command) throw new Error("MCP server must have a url or command")
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    stderr: "inherit",
  })
}

export async function startMcpServers(configs = configuredServers()): Promise<void> {
  if (sessions.length > 0) throw new Error("MCP servers are already started")
  try {
    for (const [name, config] of Object.entries(configs)) {
      const client = new Client({ name: `niri-${process.env.NIRI_AGENT_ID ?? "agent"}-${name}`, version: "1.0.0" })
      await client.connect(transportFor(config), { timeout: 30_000 })
      const session: McpSession = { name, client, tools: new Map() }
      sessions.push(session)

      let cursor: string | undefined
      do {
        const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 })
        for (const tool of listed.tools) {
          const publicName = publicToolName(name, tool.name)
          if (toolOwners.has(publicName)) throw new Error(`duplicate MCP tool name after normalization: ${publicName}`)
          session.tools.set(publicName, tool.name)
          toolOwners.set(publicName, { session, remoteName: tool.name })
          toolDefinitions.push({
            type: "function",
            function: {
              name: publicName,
              description: `[MCP ${name}] ${tool.description?.trim() || tool.name}`,
              parameters: tool.inputSchema as unknown as JsonSchema,
            },
          })
        }
        cursor = listed.nextCursor
      } while (cursor)

      console.log(`[mcp] ${name}: connected and registered ${session.tools.size} tool(s)`)
    }
  } catch (error) {
    await stopMcpServers()
    throw error
  }
}

export function getMcpToolDefinitions(): ToolDefinition[] {
  return [...toolDefinitions]
}

export function hasMcpTool(name: string): boolean {
  return toolOwners.has(name)
}

function formatContentPart(part: Record<string, unknown>): string {
  if (part.type === "text" && typeof part.text === "string") return part.text
  if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
    const bytes = Math.floor(part.data.length * 0.75)
    return `[${part.type} ${String(part.mimeType ?? "unknown type")}, approximately ${bytes} bytes]`
  }
  if (part.type === "resource" && part.resource && typeof part.resource === "object") {
    const resource = part.resource as Record<string, unknown>
    if (typeof resource.text === "string") return `${String(resource.uri ?? "resource")}\n${resource.text}`
    return JSON.stringify({ ...resource, blob: resource.blob ? "[binary data omitted]" : undefined }, null, 2)
  }
  return JSON.stringify(part, null, 2)
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const owner = toolOwners.get(name)
  if (!owner) throw new Error(`unknown MCP tool ${name}`)
  const result = await owner.session.client.callTool(
    { name: owner.remoteName, arguments: args },
    undefined,
    { timeout: 10 * 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 10 * 60_000 },
  )

  if ("toolResult" in result) return JSON.stringify(result.toolResult, null, 2)
  const parts = result.content.map((part) => formatContentPart(part as unknown as Record<string, unknown>))
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2))
  const content = parts.filter(Boolean).join("\n\n") || "(empty MCP tool result)"
  return result.isError ? `error: ${content}` : content
}

export async function stopMcpServers(): Promise<void> {
  const active = sessions.splice(0).reverse()
  toolDefinitions.length = 0
  toolOwners.clear()
  await Promise.allSettled(active.map(async ({ name, client }) => {
    try {
      await client.close()
    } catch (error) {
      console.warn(`[mcp] ${name}: close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
}

export const __mcpTest = { formatContentPart, httpHeaders, publicToolName }
