import path from "node:path"
import { fileURLToPath } from "node:url"
import { deleteAgent, initControlDb, upsertAgent } from "./control/db"
import { createControlServer } from "./control/server"
import {
  assertNoDuplicateDiscordTokens,
  assertNoDuplicateBridgePorts,
  buildWorkerEnvironment,
  loadAgentFiles,
  resolveLocalAgents,
} from "./local-agents"
import { LocalAgentSupervisor } from "./supervisor"
import { startIrohAcceptor, type IrohAgentDialIn } from "./iroh"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const controlPort = Number.parseInt(argument("--port") ?? "3000", 10)
const controlHost = argument("--host") ?? "127.0.0.1"
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workerEntry = path.join(repoRoot, "packages", "niri-runtime", "src", "index.ts")
const agentDirectory = path.resolve(argument("--agents") ?? path.join(repoRoot, "agents"))

const CONTROL_HOME = path.resolve(process.env.NIRI_CONTROL_HOME ?? path.join(repoRoot, "data", "control"))
const IROH_SECRET_FILE = process.env.NIROH_SECRET_FILE ?? path.join(CONTROL_HOME, "iroh.secret")
const IROH_TOKEN_FILE = process.env.NIROH_TOKEN_FILE ?? path.join(CONTROL_HOME, "iroh.token")

async function main(): Promise<void> {
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error(`invalid control port: ${argument("--port")}`)
  }
  process.umask(0o077)

  initControlDb()
  const agents = resolveLocalAgents(loadAgentFiles(agentDirectory), { controlPort, repoRoot })
  assertNoDuplicateDiscordTokens(agents)
  assertNoDuplicateBridgePorts(agents, controlPort)

  const remoteAgentIds = new Set(agents.filter((agent) => agent.workerMode === "remote").map((agent) => agent.id))
  const localAgents = agents.filter((agent) => agent.workerMode === "local")
  const remoteAgents = agents.filter((agent) => agent.workerMode === "remote")

  const supervisors = new Map<string, LocalAgentSupervisor>()
  for (const agent of localAgents) {
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
  console.log(`[server] control plane listening on ${controlHost}:${controlPort}; local agents=${supervisors.size}, remote agents=${remoteAgents.length}`)

  const handleDialIn = (dialIn: IrohAgentDialIn) => {
    upsertAgent({
      id: dialIn.agentId,
      name: dialIn.name,
      baseUrl: dialIn.baseUrl,
    })
  }

  // Iroh acceptor: never fatal — failure to bind is a warning, not a crash.
  let irohAcceptor: { close: () => Promise<void> } | null = null
  try {
    irohAcceptor = await startIrohAcceptor({
      secretFile: IROH_SECRET_FILE,
      tokenFile: IROH_TOKEN_FILE,
      onAgent: handleDialIn,
      onAgentGone: (agentId) => {
        // Drop the stale tunnel URL so nothing routes to a reused ephemeral port.
        deleteAgent(agentId)
      },
      allowAgent: (agentId) => remoteAgentIds.has(agentId),
    })
  } catch (err) {
    console.warn(`[iroh] acceptor failed to start (continuing without iroh): ${err instanceof Error ? err.message : String(err)}`)
  }

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[server] ${signal} received, stopping ${supervisors.size} local agent(s)`)
    await server.close()
    await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()))
    if (irohAcceptor) await irohAcceptor.close().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[server] fatal:", error)
  process.exit(1)
})
