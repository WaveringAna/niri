#!/usr/bin/env node
import os from "node:os"
import path from "node:path"
import { NodeToolHost, parseToolCapabilities } from "./host.js"
import { RemoteToolClient } from "./remote.js"

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function fileSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

async function main(): Promise<void> {
  const endpoint = required("HARNESS_ENDPOINT").replace(/\/+$/, "")
  const agentId = required("HARNESS_AGENT_ID")
  const clientId = process.env.HARNESS_CLIENT_ID?.trim() || `${agentId}-local`
  const workspaceRoot = path.resolve(required("HARNESS_CLIENT_WORKSPACE"))
  const stateDir = path.resolve(
    process.env.HARNESS_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "mira-harness", "clients"),
  )
  const host = new NodeToolHost({
    capabilities: parseToolCapabilities(process.env.HARNESS_CLIENT_CAPABILITIES),
    workspace: {
      id: process.env.HARNESS_CLIENT_WORKSPACE_ID?.trim() || path.basename(workspaceRoot) || "workspace",
      root: workspaceRoot,
    },
  })
  const client = new RemoteToolClient({
    endpoint,
    agentId,
    clientId,
    token: required("HARNESS_TOKEN"),
    host,
    journalPath: process.env.HARNESS_JOURNAL ?? path.join(stateDir, `${fileSafe(agentId)}-${fileSafe(clientId)}.json`),
    onStatus: (status) => console.log(`[harness-tool-client] ${status}`),
  })

  let closing = false
  const close = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log(`[harness-tool-client] ${signal} received, disconnecting`)
    await client.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void close("SIGINT"))
  process.on("SIGTERM", () => void close("SIGTERM"))
  await client.start()
}

main().catch((error) => {
  console.error(`[harness-tool-client] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
