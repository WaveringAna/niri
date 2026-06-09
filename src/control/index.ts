import { initControlDb } from "./db"
import { registerConfiguredAgents } from "./config"
import { createControlServer } from "./server"

const PORT = Number.parseInt(process.env.CONTROL_PORT ?? process.env.PORT ?? "3001", 10)

async function main() {
  console.log("[control] starting up...")
  initControlDb()
  registerConfiguredAgents()

  const server = createControlServer()
  await server.listen({ port: PORT, host: "0.0.0.0" })
  console.log(`[control] listening on :${PORT}`)

  let shuttingDown = false
  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[control] ${sig} received, shutting down...`)
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
}

main().catch((err) => {
  console.error("[control] fatal:", err)
  process.exit(1)
})
