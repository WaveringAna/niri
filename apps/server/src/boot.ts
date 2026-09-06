import path from "node:path"
import { fileURLToPath } from "node:url"
import { deleteAgent, initControlDb, upsertAgent } from "./control/db"
import { createControlServer } from "./control/server"
import { ConfigStore } from "./control/config-store"
import type { AgentConfig } from "@niri/agent-config"
import { deriveAgentToken, getOrCreateToken } from "./control/config-auth"
import { loadAgentFiles, resolveLocalAgents } from "./local-agents"
import { AgentManager } from "./agent-manager"
import { startIrohAcceptor, type IrohAgentDialIn, type IrohClientDialIn } from "./iroh"
import { acceptClientReverseRpc } from "./client-reverse-rpc"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

export type ControlPlaneOptions = {
  port: number
  host?: string
  agentsDirectory?: string
  controlHome?: string
  controlDb?: string
  irohSecretFile?: string
  irohTokenFile?: string
  workerEntry?: string
}

export type ControlPlane = {
  port: number
  host: string
  /** Graceful stop: control server, managed agents, iroh acceptor, tunnels, stores. */
  close: () => Promise<void>
}

/**
 * Boot the whole control plane in-process. The `apps/server` script and the
 * `niri serve` cli command are thin wrappers over this function; everything
 * durable (config store, tokens, port allocations) is passed explicitly so an
 * embedding process controls its own filesystem layout.
 */
export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
  const controlPort = options.port
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) throw new Error(`invalid control port: ${controlPort}`)
  const controlHost = options.host ?? "127.0.0.1"
  const repoRoot = REPO_ROOT
  const workerEntry = options.workerEntry ?? path.join(repoRoot, "packages", "niri-runtime", "src", "index.ts")
  const agentDirectory = path.resolve(options.agentsDirectory ?? path.join(repoRoot, "agents"))
  const CONTROL_HOME = path.resolve(options.controlHome ?? process.env.NIRI_CONTROL_HOME ?? path.join(repoRoot, "data", "control"))
  const CONTROL_DB = path.resolve(options.controlDb ?? process.env.NIRI_CONTROL_DB ?? path.join(CONTROL_HOME, "control.db"))
  // Runtime config deliberately accepts only a loopback authority. Wildcard
  // bindings remain usable through loopback; reject other explicit binds instead
  // of issuing workers an authority their runtime will refuse.
  const configServerHost = ["0.0.0.0", "127.0.0.1", "localhost"].includes(controlHost) ? "127.0.0.1"
    : ["::", "::1"].includes(controlHost) ? "::1" : undefined
  if (!configServerHost) throw new Error(`managed runtime configuration requires a loopback or wildcard host, got ${controlHost}`)
  const IROH_SECRET_FILE = options.irohSecretFile ?? process.env.NIROH_SECRET_FILE ?? path.join(CONTROL_HOME, "iroh.secret")
  const IROH_TOKEN_FILE = options.irohTokenFile ?? process.env.NIROH_TOKEN_FILE ?? path.join(CONTROL_HOME, "iroh.token")

  process.umask(0o077)
  initControlDb(CONTROL_DB)
  const store = new ConfigStore(CONTROL_DB)
  const adminToken = getOrCreateToken(path.join(CONTROL_HOME, "admin.token"))
  const manager = new AgentManager({
    store, repoRoot, workerEntry, controlPort, controlHome: CONTROL_HOME,
    configServerUrl: `http://${configServerHost.includes(":") ? `[${configServerHost}]` : configServerHost}:${controlPort}`,
    agentToken: (id) => deriveAgentToken(adminToken, id),
  })
  store.setValidator((config, id) => manager.validate(config, id))

  // YAML is a one-way bootstrap import. Once a durable row exists it remains
  // authoritative, and an empty or absent agents directory is a valid boot.
  const yaml = loadAgentFiles(agentDirectory)
  // Preserve legacy allocation layout: all worker ports were allocated before
  // the separate iroh tunnel range. This happens only for an empty durable DB.
  if (store.list().length === 0 && yaml.length) manager.reserveLegacy(resolveLocalAgents(yaml, { controlPort, repoRoot }))
  for (const { config, source } of yaml) {
    // Legacy YAML inferred id from filename; preserve that migration behavior.
    const id = config.id ?? path.basename(source).replace(/\.ya?ml$/i, "")
    if (!store.get(id)) store.seed({ config: { ...config, id } as AgentConfig, actor: "seed", reason: "yaml bootstrap" })
  }

  const server = createControlServer({
    configuration: { store, manager, adminToken, agentToken: (id) => deriveAgentToken(adminToken, id) },
    configuredAgentIds: manager.configuredAgentIds,
    webhooks: manager.webhooks,
    stopLocalAgent: async (id) => { await manager.stop(id); return true },
  })
  const clientConnections = new Map<string, IrohClientDialIn["connection"]>()

  try {
    await server.listen({ port: controlPort, host: controlHost })
    manager.startEnabled()
  } catch (error) {
    await server.close().catch(() => {})
    await manager.close()
    store.close()
    throw error
  }
  console.log(`[server] control plane listening on ${controlHost}:${controlPort}`)

  const handleDialIn = (dialIn: IrohAgentDialIn) => {
    // Do not re-register a disabled/deleted config after a stale remote dial-in.
    if (!store.get(dialIn.agentId)?.enabled) return
    upsertAgent({ id: dialIn.agentId, name: dialIn.name, baseUrl: dialIn.baseUrl })
  }
  const handleClientDialIn = (dialIn: IrohClientDialIn) => {
    const tunnel = manager.clientTunnels.get(dialIn.agentId)
    if (!tunnel) throw new Error(`no iroh client tunnel for agent ${dialIn.agentId}`)
    const prior = clientConnections.get(dialIn.agentId)
    if (prior && prior !== dialIn.connection) prior.close(0n, Array.from(Buffer.from("replaced", "utf8")))
    clientConnections.set(dialIn.agentId, dialIn.connection)
    tunnel.setConnection(dialIn.connection)
    void acceptClientReverseRpc(dialIn, {
      isCurrent: (agentId, connection) => clientConnections.get(agentId) === connection,
      onError: (agentId, error) => {
        if (clientConnections.get(agentId) === dialIn.connection) console.warn(`[iroh] reverse RPC bridge for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    }).catch((error) => {
      if (clientConnections.get(dialIn.agentId) === dialIn.connection) console.warn(`[iroh] reverse RPC bridge for ${dialIn.agentId} stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  let irohAcceptor: { close: () => Promise<void> } | null = null
  try {
    irohAcceptor = await startIrohAcceptor({
      secretFile: IROH_SECRET_FILE, tokenFile: IROH_TOKEN_FILE,
      onAgent: handleDialIn,
      onAgentGone: (agentId) => { deleteAgent(agentId) },
      allowAgent: (agentId) => manager.remoteAgentIds.has(agentId) && Boolean(store.get(agentId)?.enabled),
      onClient: handleClientDialIn,
      onClientGone: (agentId, _instanceId, connection) => {
        if (clientConnections.get(agentId) !== connection) return
        clientConnections.delete(agentId)
        manager.clientTunnels.get(agentId)?.setConnection(null)
      },
      allowClient: (agentId) => manager.clientTunnels.has(agentId),
    })
  } catch (error) { console.warn(`[iroh] acceptor failed to start (continuing without iroh): ${error instanceof Error ? error.message : String(error)}`) }

  let closing = false
  return {
    port: controlPort,
    host: controlHost,
    close: async () => {
      if (closing) return
      closing = true
      await server.close()
      await manager.close()
      await irohAcceptor?.close().catch(() => {})
      store.close()
    },
  }
}
