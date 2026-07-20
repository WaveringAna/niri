import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { NodeToolHost, ToolClientHttpServer, parseToolCapabilities } from "@mira/harness-client-node"
import { bindEndpoint, dialControlPlane, loadOrCreateSecretKey, openSocketStream } from "@niri/iroh-transport"
import type { Connection, Endpoint } from "@number0/iroh"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const IROH_TICKET = argument("--iroh-ticket")?.trim() || process.env.NIRI_SERVER_IROH_TICKET?.trim()
const IROH_TOKEN = argument("--iroh-token")?.trim() || process.env.NIRI_SERVER_IROH_TOKEN?.trim()
const IROH_AGENT_ID = argument("--agent")?.trim() || process.env.NIRI_AGENT_ID?.trim()
const IROH_INSTANCE_ID = process.env.NIRI_WORKER_INSTANCE_ID?.trim() || randomUUID()

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Keep a connection to the control plane open forever: dial, then pump every
 * server-initiated BiStream to the loopback tool-client HTTP server. The
 * control plane's tunnel reaches this client through NATs, so the client
 * never needs a public listener. Retries with exponential backoff.
 */
async function runIrohLink(endpoint: Endpoint, port: number, signal: AbortSignal): Promise<void> {
  let firstSuccess = true
  let delay = RECONNECT_MIN_MS
  while (!signal.aborted) {
    let connection: Connection | null = null
    try {
      connection = await dialControlPlane({
        endpoint,
        ticket: IROH_TICKET!,
        token: IROH_TOKEN!,
        identity: { agentId: IROH_AGENT_ID!, instanceId: IROH_INSTANCE_ID, name: IROH_AGENT_ID!, role: "client" },
      })
      if (firstSuccess) {
        console.log(`[tool-client] connected to control plane over iroh as client for ${IROH_AGENT_ID}`)
        firstSuccess = false
      } else {
        console.log(`[tool-client] reconnected to control plane over iroh`)
      }
      delay = RECONNECT_MIN_MS

      const closedP = connection.closed()
      while (!signal.aborted) {
        const outcome = await Promise.race([
          openSocketStream(connection, port).then(() => "pumped" as const),
          closedP.then(() => "closed" as const),
        ]).catch(() => "closed" as const)
        if (outcome === "closed") break
      }
    } catch (err) {
      if (signal.aborted) return
      console.warn(`[tool-client] iroh connect/pump failed (retry in ${delay}ms): ${err instanceof Error ? err.message : String(err)}`)
      await sleep(delay)
      delay = Math.min(RECONNECT_MAX_MS, delay * 2)
    } finally {
      connection?.close(0n, [])
    }
  }
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(argument("--workspace") ?? os.homedir())
  const irohEnabled = Boolean(IROH_TICKET && IROH_TOKEN)
  if (irohEnabled && !IROH_AGENT_ID) {
    throw new Error("iroh mode requires --agent <id> or NIRI_AGENT_ID")
  }
  const host = new NodeToolHost({
    capabilities: parseToolCapabilities(argument("--capabilities")),
    workspace: { id: path.basename(workspaceRoot) || "workspace", root: workspaceRoot },
  })
  const client = new ToolClientHttpServer({
    host,
    // Iroh mode serves the control plane's tunnel only; keep the listener local.
    listenHost: argument("--host") ?? (irohEnabled ? "127.0.0.1" : "0.0.0.0"),
    port: Number.parseInt(argument("--port") ?? "3002", 10),
  })

  let closing = false
  const linkAbort = new AbortController()
  let linkEndpoint: Endpoint | null = null
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[tool-client] ${signal} received, stopping`)
    linkAbort.abort()
    await client.stop()
    if (linkEndpoint) await linkEndpoint.close().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  const address = await client.start()
  console.log(`[tool-client] listening on ${address.host}:${address.port}; workspace=${workspaceRoot}`)

  if (irohEnabled) {
    const secret = await loadOrCreateSecretKey(path.join(os.homedir(), ".niri-client", "iroh.secret"))
    linkEndpoint = await bindEndpoint(secret)
    void runIrohLink(linkEndpoint, address.port, linkAbort.signal)
  }
}

main().catch((error) => {
  console.error("[tool-client] fatal:", error)
  process.exit(1)
})
