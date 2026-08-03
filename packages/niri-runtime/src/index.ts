import { spawn } from "node:child_process"
import { REPO_ROOT } from "./agent-config"
import { createServer } from "./server"
import { initDb } from "./db"
import { initMetricsDb } from "./metrics"
import { enqueueEvent, isRunning, shutdown, wake } from "./runner/index"
import { startDiscordGateway } from "./discord/gateway"
import { startPostureReminder } from "./discord/posture"
import { startDiscordEmbeddingBackfill } from "./discord/search"
import { setDiscordToolsAvailable } from "./discord/availability"
import { ensureSoulFilePlacement } from "./bootstrap"
import { startAntigravityBridge, stopAntigravityBridge } from "./antigravity-bridge"
import { startCodexBridge, stopCodexBridge } from "./codex-bridge"
import { startIrohLink, stopIrohLink } from "./iroh-link"
import { startScheduler } from "./scheduler"
import { clientTools } from "./client"
import { startMcpServers, stopMcpServers } from "./mcp"
import { initDelegation, stopDelegation } from "./delegation/manager"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const WORKER_HOST = process.env.NIRI_WORKER_HOST?.trim() || "127.0.0.1"
const RESTART_COMMAND = process.env.NIRI_RESTART_COMMAND?.trim() || "npm run start:worker"
const MANAGED_WORKER = process.env.NIRI_MANAGED_WORKER?.trim().toLowerCase() === "true"

function spawnReplacementProcess(): void {
  console.log(`[niri] spawning replacement: ${RESTART_COMMAND}`)
  const child = spawn(RESTART_COMMAND, {
    cwd: process.env.NIRI_RESTART_CWD?.trim() || REPO_ROOT,
    env: process.env,
    shell: true,
    detached: true,
    stdio: "inherit",
  })
  child.unref()
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`invalid worker port: ${process.env.PORT}`)
  process.umask(0o077)
  console.log("[niri] starting up...")

  await clientTools.start()
  await startMcpServers()

  await ensureSoulFilePlacement()
  initDb()
  initMetricsDb()
  try {
    await startAntigravityBridge()
    await startCodexBridge()
  } catch (err) {
    console.error("[bridge] failed to start:", err)
  }

  const discordEmbeddingBackfill = startDiscordEmbeddingBackfill()

  let discordGateway: Awaited<ReturnType<typeof startDiscordGateway>> = null
  try {
    discordGateway = await startDiscordGateway()
  } catch (err) {
    console.warn("[discord gateway] startup failed:", err)
  }
  setDiscordToolsAvailable(Boolean(discordGateway))
  initDelegation((event, options) => {
    if (isRunning()) enqueueEvent(event, options)
    else void wake(event)
  })

  let shuttingDown = false
  let restartRequested = false
  let restartReason: string | undefined
  let stopScheduler: () => void = () => {}
  let stopPostureReminder: () => void = () => {}

  function requestRestart(reason?: string): void {
    if (restartRequested || shuttingDown) return
    restartRequested = true
    restartReason = reason?.trim() || undefined
    setTimeout(() => {
      void gracefulShutdown("RESTART")
    }, 50).unref?.()
  }

  function requestShutdown(): void {
    if (restartRequested || shuttingDown) return
    setTimeout(() => {
      void gracefulShutdown("SHUTDOWN")
    }, 50).unref?.()
  }

  const server = createServer({ requestRestart, requestShutdown })

  await server.listen({ port: PORT, host: WORKER_HOST })
  console.log(`[niri] listening on ${WORKER_HOST}:${PORT}`)

  stopPostureReminder = startPostureReminder((message) => {
    const event = {
      source: "cron" as const,
      triggeredAt: new Date().toISOString(),
      content: message,
      raw: { type: "posture_reminder" },
    }
    if (isRunning()) {
      enqueueEvent(event, { priority: true })
    } else {
      void wake(event)
    }
  })

  // Dial the control plane over iroh if NIRI_SERVER_IROH_TICKET is set; no-op otherwise.
  await startIrohLink()

  stopScheduler = startScheduler()

  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return  // ignore duplicate signals
    shuttingDown = true
    stopScheduler()
    stopPostureReminder()
    const detail = restartRequested && restartReason ? ` (${restartReason})` : ""
    console.log(`\n[niri] ${sig} received${detail}, saving session snapshot...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[niri] shutdown timed out, forcing exit"); resolve() }, 60_000)
    )

    await Promise.race([shutdown(), timeout])

    const cleanup = async () => {
      discordEmbeddingBackfill.stop()
      stopDelegation()
      if (discordGateway) await discordGateway.stop()
      setDiscordToolsAvailable(false)
      await clientTools.stop()
      await stopMcpServers()
      await stopAntigravityBridge()
      await stopCodexBridge()
      await stopIrohLink()
    }
    const cleanupTimeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[niri] cleanup timed out, exiting anyway"); resolve() }, 10_000)
    )
    await Promise.race([cleanup(), cleanupTimeout])
    if (restartRequested && !MANAGED_WORKER) spawnReplacementProcess()
    process.exit(0)
  }

  process.on("SIGINT", async () => {
    if (shuttingDown) {
      console.log("\n[niri] force exit")
      process.exit(1)
    }
    await gracefulShutdown("SIGINT")
  })

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
}

main().catch((err) => {
  console.error("[niri] fatal:", err)
  process.exit(1)
})
