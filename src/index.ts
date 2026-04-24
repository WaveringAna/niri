import { openBash, closeBash } from "./container/index.js"
import { createServer } from "./server.js"
import { initDb } from "./db.js"
import { initMetricsDb } from "./metrics.js"
import { shutdown } from "./runner/index.js"
import { startDiscordGateway } from "./discord/gateway.js"
import { ensureSoulFilePlacement } from "./bootstrap.js"

const PORT = parseInt(process.env.PORT ?? "3000")

async function main() {
  console.log("[niri] starting up...")

  await ensureSoulFilePlacement()
  initDb()
  initMetricsDb()
  await openBash()

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
    console.log(`\n[niri] ${sig} received, asking niri to journal and rest...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[niri] shutdown timed out, forcing exit"); resolve() }, 60_000)
    )

    await Promise.race([shutdown(), timeout])

    if (discordGateway) await discordGateway.stop()
    await server.close()
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
