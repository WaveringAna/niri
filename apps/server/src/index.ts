import path from "node:path"
import { fileURLToPath } from "node:url"
import { initControlDb, upsertAgent } from "./control/db"
import { createControlServer } from "./control/server"
import {
  assertNoDuplicateDiscordTokens,
  assertNoDuplicateBridgePorts,
  buildWorkerEnvironment,
  loadAgentFiles,
  resolveLocalAgents,
} from "./local-agents"
import { LocalAgentSupervisor } from "./supervisor"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const controlPort = Number.parseInt(argument("--port") ?? "3000", 10)
const controlHost = argument("--host") ?? "127.0.0.1"
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workerEntry = path.join(repoRoot, "packages", "niri-runtime", "src", "index.ts")
const agentDirectory = path.resolve(argument("--agents") ?? path.join(repoRoot, "agents"))

async function main(): Promise<void> {
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error(`invalid control port: ${argument("--port")}`)
  }
  process.umask(0o077)

  initControlDb()
  const agents = resolveLocalAgents(loadAgentFiles(agentDirectory), { controlPort, repoRoot })
  assertNoDuplicateDiscordTokens(agents)
  assertNoDuplicateBridgePorts(agents, controlPort)

  const supervisors = new Map<string, LocalAgentSupervisor>()
  for (const agent of agents) {
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
        })
      },
    }))
  }

  const server = createControlServer({
    configuredAgentIds: new Set(agents.map((agent) => agent.id)),
    webhooks: new Map(agents.map((agent) => [agent.id, agent.webhooks])),
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
