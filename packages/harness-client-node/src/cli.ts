#!/usr/bin/env node
import path from "node:path"
import os from "node:os"
import { NodeToolHost, parseToolCapabilities } from "./host.js"
import { ToolClientHttpServer } from "./http-server.js"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(argument("--workspace") ?? os.homedir())
  const host = new NodeToolHost({
    capabilities: parseToolCapabilities(argument("--capabilities")),
    workspace: { id: path.basename(workspaceRoot) || "workspace", root: workspaceRoot },
  })
  const client = new ToolClientHttpServer({
    host,
    listenHost: argument("--host") ?? "0.0.0.0",
    port: Number.parseInt(argument("--port") ?? "3002", 10),
  })

  let closing = false
  const close = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log(`[harness-tool-client] ${signal} received, stopping`)
    await client.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void close("SIGINT"))
  process.on("SIGTERM", () => void close("SIGTERM"))

  const address = await client.start()
  console.log(`[harness-tool-client] listening on ${address.host}:${address.port}; workspace=${workspaceRoot}`)
}

main().catch((error) => {
  console.error(`[harness-tool-client] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
