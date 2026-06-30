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

  const server = createServer()

  await server.listen({ port: PORT, host: "0.0.0.0" })
  console.log(`[niri] listening on :${PORT}`)

  let shuttingDown = false

  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return  // ignore duplicate signals
    shuttingDown = true
    console.log(`\n[niri] ${sig} received, saving session snapshot...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[niri] shutdown timed out, forcing exit"); resolve() }, 60_000)
    )

    await Promise.race([shutdown(), timeout])

    discordEmbeddingBackfill.stop()
    if (discordGateway) await discordGateway.stop()
    await server.close()
    await stopAntigravityBridge()
    closeBash()
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
