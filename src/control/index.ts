import { initControlDb, upsertAgent } from "./db"
import { createControlServer } from "./server"

const PORT = Number.parseInt(process.env.CONTROL_PORT ?? process.env.PORT ?? "3001", 10)

type ConfiguredAgent = {
  id: string
  name?: string
  baseUrl: string
  token?: string
}

function parseConfiguredAgents(): ConfiguredAgent[] {
  const json = process.env.NIRI_AGENTS_JSON?.trim()
  if (json) {
    const parsed = JSON.parse(json) as ConfiguredAgent[]
    if (!Array.isArray(parsed)) throw new Error("NIRI_AGENTS_JSON must be an array")
    return parsed
  }

  const compact = process.env.NIRI_AGENTS?.trim()
  if (compact) {
    return compact
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [idPart, baseUrlPart] = entry.split("=", 2)
        const id = idPart?.trim() ?? ""
        const baseUrl = baseUrlPart?.trim() ?? ""
        if (!id || !baseUrl) throw new Error(`invalid NIRI_AGENTS entry: ${entry}`)
        return { id, baseUrl }
      })
  }

  const defaultUrl = process.env.NIRI_AGENT_URL?.trim()
  if (defaultUrl) {
    return [
      {
        id: process.env.NIRI_AGENT_ID?.trim() || "niri",
        baseUrl: defaultUrl,
      },
    ]
  }

  return []
}

async function main() {
  console.log("[control] starting up...")
  initControlDb()

  for (const agent of parseConfiguredAgents()) {
    upsertAgent(agent)
    console.log(`[control] registered ${agent.id} -> ${agent.baseUrl}`)
  }

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
