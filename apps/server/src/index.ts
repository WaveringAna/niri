import path from "node:path"
import { fileURLToPath } from "node:url"
import { registerConfiguredAgents } from "./control/config"
import { initControlDb, upsertAgent } from "./control/db"
import { createControlServer } from "./control/server"
import {
  assertNoDuplicateDiscordTokens,
  assertNoDuplicateBridgePorts,
  buildWorkerEnvironment,
  parseLocalAgents,
  resolveLocalAgents,
} from "./local-agents"
import { LocalAgentSupervisor } from "./supervisor"

const controlPort = Number.parseInt(process.env.CONTROL_PORT ?? process.env.PORT ?? "3000", 10)
const controlHost = process.env.NIRI_CONTROL_HOST?.trim() || "127.0.0.1"
const controlToken = process.env.NIRI_CONTROL_TOKEN?.trim()
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workerEntry = path.join(repoRoot, "packages", "niri-runtime", "src", "index.ts")

async function main(): Promise<void> {
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error(`invalid control port: ${process.env.CONTROL_PORT ?? process.env.PORT}`)
  }
  if (!controlToken) throw new Error("NIRI_CONTROL_TOKEN is required")
  process.umask(0o077)

  initControlDb()
  registerConfiguredAgents()
  const agents = resolveLocalAgents(parseLocalAgents(process.env, controlPort), { controlPort, repoRoot, controlToken })
  assertNoDuplicateDiscordTokens(agents, process.env)
  assertNoDuplicateBridgePorts(agents, process.env, controlPort)

  const supervisors = new Map<string, LocalAgentSupervisor>()
  for (const agent of agents) {
    if (!agent.toolClientToken) {
      console.warn(`[server] ${agent.id} has no tool client token; client-owned tools are disabled`)
    }
    supervisors.set(agent.id, new LocalAgentSupervisor({
      agent,
      repoRoot,
      workerEntry,
      workerEnv: buildWorkerEnvironment(process.env, agent),
      onReady: (readyAgent) => {
        upsertAgent({
          id: readyAgent.id,
          name: readyAgent.name,
          baseUrl: `http://127.0.0.1:${readyAgent.port}`,
          token: readyAgent.workerToken,
        })
      },
    }))
  }

  const server = createControlServer({
    token: controlToken,
    stopLocalAgent: async (id) => {
      const supervisor = supervisors.get(id)
      if (!supervisor) return false
      await supervisor.stop()
      return true
    },
  })

  try {
    await server.listen({ port: controlPort, host: controlHost })
    await Promise.all([...supervisors.values()].map((supervisor) => supervisor.start()))
  } catch (error) {
    await server.close().catch(() => {})
    await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()))
    throw error
  }
  console.log(`[server] control plane listening on ${controlHost}:${controlPort}; local agents=${supervisors.size}`)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[server] ${signal} received, stopping ${supervisors.size} local agent(s)`)
    await server.close()
    await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()))
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[server] fatal:", error)
  process.exit(1)
})
