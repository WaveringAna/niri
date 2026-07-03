import { spawn } from "node:child_process"
import { openBash, closeBash } from "./container/index"
import { createServer } from "./server"
import { initDb } from "./db"
import { initMetricsDb } from "./metrics"
import { initControlDb } from "./control/db"
import { registerConfiguredAgents } from "./control/config"
import { shutdown } from "./runner/index"
import { startDiscordGateway } from "./discord/gateway"
import { startDiscordEmbeddingBackfill } from "./discord/search"
import { ensureSoulFilePlacement } from "./bootstrap"
import { startAntigravityBridge, stopAntigravityBridge } from "./antigravity-bridge"

const PORT = parseInt(process.env.PORT ?? "3000")
const RESTART_COMMAND = process.env.NIRI_RESTART_COMMAND?.trim() || "npm run start"

function spawnReplacementProcess(): void {
  console.log(`[niri] spawning replacement: ${RESTART_COMMAND}`)
  const child = spawn(RESTART_COMMAND, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    detached: true,
    stdio: "inherit",
  })
  child.unref()
}

async function main() {
  console.log("[niri] starting up...")

  await ensureSoulFilePlacement()
  initDb()
  initMetricsDb()
  initControlDb()
  registerConfiguredAgents()
  await openBash()

  // Start the Antigravity Bridge if enabled in .env
  try {
    await startAntigravityBridge()
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

  let shuttingDown = false
  let restartRequested = false
  let restartReason: string | undefined

  function requestRestart(reason?: string): void {
    if (restartRequested || shuttingDown) return
    restartRequested = true
    restartReason = reason?.trim() || undefined
    setTimeout(() => {
      void gracefulShutdown("RESTART")
    }, 50).unref?.()
  }

  const server = createServer({ requestRestart })

  await server.listen({ port: PORT, host: "0.0.0.0" })
  console.log(`[niri] listening on :${PORT}`)

  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return  // ignore duplicate signals
    shuttingDown = true
    const detail = restartRequested && restartReason ? ` (${restartReason})` : ""
    console.log(`\n[niri] ${sig} received${detail}, saving session snapshot...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[niri] shutdown timed out, forcing exit"); resolve() }, 60_000)
    )

    await Promise.race([shutdown(), timeout])

    discordEmbeddingBackfill.stop()
    if (discordGateway) await discordGateway.stop()
    await server.close()
    await stopAntigravityBridge()
    closeBash()
    if (restartRequested) spawnReplacementProcess()
    process.exit(0)
  }

  // Second SIGINT = user is insisting
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
