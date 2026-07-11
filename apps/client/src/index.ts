import path from "node:path"
import os from "node:os"
import { NodeToolHost, RemoteToolClient, parseToolCapabilities } from "@mira/harness-client-node"

function requiredIdentity(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must not be empty`)
  return normalized
}

function fileSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`expected a positive integer, got ${value}`)
  return Math.trunc(parsed)
}

function optionalStringMap(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NIRI_CLIENT_SHELL_ENV_JSON must be an object of strings")
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error(`NIRI_CLIENT_SHELL_ENV_JSON.${key} must be a string`)
    result[key] = item
  }
  return result
}

const agentId = requiredIdentity(process.env.NIRI_AGENT_ID ?? process.env.AGENT_ID ?? "niri", "NIRI_AGENT_ID")
const clientId = requiredIdentity(process.env.NIRI_CLIENT_ID ?? `${agentId}-local`, "NIRI_CLIENT_ID")
const serverUrl = (process.env.NIRI_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "")
const directWorker = process.env.NIRI_TOOL_CLIENT_DIRECT_WORKER?.trim().toLowerCase() === "true"
const endpoint = (
  process.env.NIRI_TOOL_CLIENT_ENDPOINT ??
  (directWorker ? `${serverUrl}/awp/client` : `${serverUrl}/agents/${encodeURIComponent(agentId)}/client`)
).replace(/\/+$/, "")
const token = process.env.NIRI_TOOL_CLIENT_TOKEN ?? ""
const workspaceRoot = path.resolve(process.env.NIRI_CLIENT_WORKSPACE ?? process.env.INIT_CWD ?? process.cwd())
const clientStateDir = path.resolve(
  process.env.NIRI_CLIENT_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "mira-harness", "clients"),
)
const journalPath = process.env.NIRI_CLIENT_JOURNAL ?? path.join(
  clientStateDir,
  `${fileSafe(agentId)}-${fileSafe(clientId)}.json`,
)

async function main(): Promise<void> {
  const host = new NodeToolHost({
    capabilities: parseToolCapabilities(process.env.NIRI_CLIENT_CAPABILITIES),
    workspace: {
      id: process.env.NIRI_CLIENT_WORKSPACE_ID?.trim() || path.basename(workspaceRoot) || "workspace",
      root: workspaceRoot,
    },
    runtime: {
      workspaceRoot,
      home: process.env.NIRI_CLIENT_HOME,
      imageRoot: process.env.IMAGE_ROOT,
      imageMaxBytes: optionalPositiveInteger(process.env.IMAGE_TOOL_MAX_BYTES),
      maxLineLength: optionalPositiveInteger(process.env.NIRI_MAX_LINE_LENGTH),
      maxResultBytes: optionalPositiveInteger(process.env.NIRI_MAX_RESULT_BYTES),
      containerName: process.env.NIRI_CONTAINER,
      containerUser: process.env.NIRI_USER,
      shellEnvironment: optionalStringMap(process.env.NIRI_CLIENT_SHELL_ENV_JSON),
    },
  })
  const client = new RemoteToolClient({
    endpoint,
    agentId,
    clientId,
    token,
    host,
    journalPath,
    onStatus: (status) => console.log(`[tool-client] ${status}`),
  })

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[tool-client] ${signal} received, disconnecting`)
    await client.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  await client.start()
}

main().catch((error) => {
  console.error("[tool-client] fatal:", error)
  process.exit(1)
})
