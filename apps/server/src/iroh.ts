import { randomBytes, timingSafeEqual } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  EndpointTicket,
  type BiStream,
  type Connection,
} from "@number0/iroh"
import {
  bindEndpoint,
  deferred,
  loadOrCreateSecretKey,
  startConnectionTunnel,
  type ConnectionTunnel,
} from "@niri/iroh-transport"

/**
 * Identity under which a worker dialed in. Passed to {@link startIrohAcceptor}'s
 * `onAgent` callback so the control plane can register the live connection.
 */
export interface IrohAgentDialIn {
  /** Agent id claimed by the worker (must match a configured remote-mode agent). */
  agentId: string
  /** Per-process worker instance id (randomUUID unless overridden by env). */
  instanceId: string
  /** Display name to surface for this agent. */
  name: string
  /** Loopback HTTP origin of this connection's tunnel; register as the agent's baseUrl. */
  baseUrl: string
}

/** A tool client that dialed in over iroh on behalf of an agent. */
export interface IrohClientDialIn {
  /** Agent id the client serves (must be an agent configured with `client: iroh`). */
  agentId: string
  /** Per-process client instance id. */
  instanceId: string
  /** Live iroh Connection the client is reachable over. */
  connection: Connection
}

export interface IrohAcceptorOptions {
  /**
   * Path to the 32-byte hex secret for this endpoint. Generated with mode 0o600
   * on first boot. Override via `NIROH_SECRET_FILE` env when convenient.
   */
  secretFile: string
  /**
   * Path to the shared base64url bearer token workers must present at dial-in.
   * Generated with mode 0o600 on first boot. Override via `NIROH_TOKEN_FILE`.
   */
  tokenFile: string
  /** Invoked after a worker completes the JSON-line handshake with a valid token. */
  onAgent: (dialIn: IrohAgentDialIn) => void | Promise<void>
  /** Invoked when a previously-connected agent's connection closes. */
  onAgentGone?: (agentId: string, instanceId: string) => void | Promise<void>
  /** Optional gate: return false to reject a dial-in's claimed agent id before registration. */
  allowAgent?: (agentId: string) => boolean
  /** Invoked after a tool client completes the handshake with a valid token. */
  onClient?: (dialIn: IrohClientDialIn) => void | Promise<void>
  /** Invoked when a previously-connected tool client's connection closes. */
  onClientGone?: (agentId: string, instanceId: string, connection: Connection) => void | Promise<void>
  /** Optional gate: return false to reject a client dial-in's claimed agent id. */
  allowClient?: (agentId: string) => boolean
  /** Endpoint preset; defaults to "n0". Tests pass "minimal" to avoid relay hang. */
  preset?: "n0" | "minimal"
}

interface LiveConnection {
  agentId: string
  instanceId: string
  connection: Connection
}

const HANDSHAKE_BYTES_LIMIT = 4096
const HANDSHAKE_TIMEOUT_MS = 10_000

function readOrCreateToken(tokenFile: string): { token: string; created: boolean } {
  try {
    const token = fsSync.readFileSync(tokenFile, "utf8").trim()
    if (token) return { token, created: false }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  const token = randomBytes(24).toString("base64url")
  return { token, created: true }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Read a single newline-terminated handshake line from the worker's control
 * BiStream, bounded by `HANDSHAKE_BYTES_LIMIT`. Returns the parsed JSON object
 * or throws on timeout, EOF, oversize, or invalid JSON.
 */
async function readHandshake(connection: Connection): Promise<{
  handshake: { agentId: unknown; instanceId: unknown; name: unknown; token: unknown; role: unknown }
  stream: BiStream
}> {
  const stream = await connection.acceptBi()
  const { promise, resolve, reject } = deferred<Buffer>()
  const timer = setTimeout(() => reject(new Error("handshake timeout")), HANDSHAKE_TIMEOUT_MS)
  timer.unref?.()
  let buf = Buffer.alloc(0)
  let settled = false
  const finish = (err: Error | null, out: Buffer | null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (err) reject(err)
    else resolve(out ?? Buffer.alloc(0))
  }

  void (async () => {
    try {
      while (true) {
        const chunk = await stream.recv.read(1024)
        if (chunk.length === 0) {
          finish(new Error("handshake ended before newline"), null)
          return
        }
        buf = Buffer.concat([buf, Buffer.from(chunk)])
        const nl = buf.indexOf("\n")
        if (nl >= 0) {
          const line = buf.subarray(0, nl)
          if (line.length > HANDSHAKE_BYTES_LIMIT) {
            finish(new Error("handshake too large"), null)
            return
          }
          // Reply on the same stream so the worker can proceed.
          finish(null, Buffer.from(line))
          return
        }
        if (buf.length > HANDSHAKE_BYTES_LIMIT) {
          finish(new Error("handshake too large"), null)
          return
        }
      }
    } catch (err) {
      finish(err as Error, null)
    }
  })()

  const line = await promise
  const text = line.toString("utf8").trim()
  if (!text) throw new Error("empty handshake")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`invalid handshake json: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("handshake must be a JSON object")
  return {
    handshake: parsed as { agentId: unknown; instanceId: unknown; name: unknown; token: unknown; role: unknown },
    stream,
  }
}

/** Write the dial-in ack and half-close the handshake stream so the worker proceeds. */
async function ackHandshake(stream: BiStream, ok: boolean, error?: string): Promise<void> {
  const ack = JSON.stringify(ok ? { ok: true } : { ok: false, error: error ?? "rejected" }) + "\n"
  await stream.send.writeAll(Array.from(Buffer.from(ack, "utf8"))).catch(() => {})
  await stream.send.finish().catch(() => {})
}

/** Registry of live iroh Connections keyed by agent id; used by control/server.ts. */
class IrohRegistry {
  private readonly byAgent = new Map<string, LiveConnection>()

  upsert(entry: LiveConnection): void {
    const prior = this.byAgent.get(entry.agentId)
    if (prior && prior.connection !== entry.connection) {
      // New instance replaces stale one; close the old connection.
      prior.connection.close(0n, Array.from(Buffer.from("replaced", "utf8")))
    }
    this.byAgent.set(entry.agentId, entry)
  }

  remove(agentId: string, instanceId: string, connection: Connection): LiveConnection | null {
    const current = this.byAgent.get(agentId)
    // Identity check: a same-instance reconnect replaces the entry, and the old
    // handler's cleanup must not evict its own replacement.
    if (!current || current.instanceId !== instanceId || current.connection !== connection) return null
    this.byAgent.delete(agentId)
    return current
  }

  get(agentId: string): Connection | null {
    return this.byAgent.get(agentId)?.connection ?? null
  }

  has(agentId: string): boolean {
    return this.byAgent.has(agentId)
  }

  statuses(): Array<{ agentId: string; instanceId: string }> {
    return [...this.byAgent.values()].map((entry) => ({ agentId: entry.agentId, instanceId: entry.instanceId }))
  }
}

const registry = new IrohRegistry()

/** True if the control plane currently has a live iroh Connection for `agentId`. */
export function agentIrohStatus(agentId: string): { connected: boolean } {
  return { connected: registry.has(agentId) }
}

/**
 * Bind the control-plane iroh endpoint, log the EndpointTicket (and the auth
 * token on first generation), then accept worker dial-ins forever. Verifies the
 * JSON-line handshake token with {@link timingSafeEqual}; on success invokes
 * `onAgent`. Connection teardown fires `onAgentGone`. Returns a handle with a
 * `close()` method for graceful shutdown.
 */
export async function startIrohAcceptor(opts: IrohAcceptorOptions): Promise<{ close: () => Promise<void>; ticket: string }> {
  const [secret] = await Promise.all([loadOrCreateSecretKey(opts.secretFile)])
  let tokenInfo: { token: string; created: boolean }
  try {
    tokenInfo = readOrCreateToken(opts.tokenFile)
    if (tokenInfo.created) {
      await fs.mkdir(path.dirname(opts.tokenFile), { recursive: true, mode: 0o700 })
      await fs.writeFile(opts.tokenFile, tokenInfo.token, { mode: 0o600 })
    }
  } catch (err) {
    throw new Error(`failed to load iroh token: ${err instanceof Error ? err.message : String(err)}`)
  }

  const endpoint = await bindEndpoint(secret, { preset: opts.preset })
  const ticket = EndpointTicket.fromAddr(endpoint.addr()).toString()
  console.log(`[iroh] control plane endpoint ready; ticket=${ticket}`)
  if (tokenInfo.created) {
    console.log(`[iroh] generated worker auth token (saved to ${opts.tokenFile}):`)
    console.log(`[iroh]   ${tokenInfo.token}`)
    console.log("[iroh] put this token in the worker's agent yaml under server.iroh.token")
  }

  let closing = false
  const acceptLoop = (async () => {
    while (!closing) {
      let incoming
      try {
        incoming = await endpoint.acceptNext()
      } catch (err) {
        if (closing) return
        console.warn(`[iroh] acceptNext failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!incoming) {
        if (closing) return
        continue
      }
      let connection: Connection | null = null
      try {
        const accepting = await incoming.accept()
        connection = await accepting.connect()
      } catch (err) {
        if (!closing) console.warn(`[iroh] incoming connect failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!connection || closing) continue
      void handleConnection(connection, opts, tokenInfo.token)
    }
  })()

  return {
    ticket,
    close: async () => {
      closing = true
      try {
        await endpoint.close()
      } catch {
        /* ignore */
      }
      await acceptLoop.catch(() => {})
    },
  }
}

async function handleConnection(
  connection: Connection,
  opts: IrohAcceptorOptions,
  expectedToken: string,
): Promise<void> {
  let agentId = "unknown"
  let instanceId = "unknown"
  try {
    let handshake: { agentId: unknown; instanceId: unknown; name: unknown; token: unknown; role: unknown }
    let stream: BiStream
    try {
      const read = await readHandshake(connection)
      handshake = read.handshake
      stream = read.stream
    } catch (err) {
      console.warn(`[iroh] handshake failed: ${err instanceof Error ? err.message : String(err)}`)
      connection.close(1n, Array.from(Buffer.from("handshake failed", "utf8")))
      return
    }
    const token = typeof handshake.token === "string" ? handshake.token : ""
    if (!safeEqual(token, expectedToken)) {
      console.warn(`[iroh] rejected dial-in: bad token (agentId=${String(handshake.agentId)})`)
      await ackHandshake(stream, false, "bad token")
      connection.close(2n, Array.from(Buffer.from("bad token", "utf8")))
      return
    }
    const id = typeof handshake.agentId === "string" ? handshake.agentId.trim() : ""
    const inst = typeof handshake.instanceId === "string" ? handshake.instanceId.trim() : ""
    if (!id || !inst) {
      console.warn(`[iroh] rejected dial-in: missing agentId or instanceId`)
      await ackHandshake(stream, false, "bad identity")
      connection.close(3n, Array.from(Buffer.from("bad identity", "utf8")))
      return
    }
    agentId = id
    instanceId = inst

    const role = handshake.role === "client" ? "client" : "worker"
    if (role === "client") {
      if (!opts.onClient || (opts.allowClient && !opts.allowClient(agentId))) {
        console.warn(`[iroh] rejected client dial-in: agent ${agentId} has no iroh client configured`)
        await ackHandshake(stream, false, "unknown client")
        connection.close(6n, Array.from(Buffer.from("unknown client", "utf8")))
        agentId = "unknown"
        return
      }
      try {
        await opts.onClient({ agentId, instanceId, connection })
      } catch (err) {
        console.warn(`[iroh] client registration failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
        await ackHandshake(stream, false, "registration failed")
        connection.close(5n, Array.from(Buffer.from("registration failed", "utf8")))
        agentId = "unknown"
        return
      }
      await ackHandshake(stream, true)
      console.log(`[iroh] tool client for ${agentId} (instance ${instanceId}) connected`)
      try {
        await connection.closed()
      } catch {
        // transport error on close is fine
      }
      console.log(`[iroh] tool client for ${agentId} (instance ${instanceId}) disconnected`)
      try {
        await opts.onClientGone?.(agentId, instanceId, connection)
      } catch (err) {
        console.warn(`[iroh] onClientGone failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
      }
      agentId = "unknown"
      return
    }

    if (opts.allowAgent && !opts.allowAgent(agentId)) {
      console.warn(`[iroh] rejected dial-in: agent ${agentId} is not a configured remote agent`)
      await ackHandshake(stream, false, "unknown agent")
      connection.close(4n, Array.from(Buffer.from("unknown agent", "utf8")))
      agentId = "unknown"
      return
    }
    const name = typeof handshake.name === "string" && handshake.name.trim() ? handshake.name.trim() : id

    // Expose the connection as a loopback tunnel: the control plane talks to
    // the worker with ordinary HTTP, and the worker pumps the streams to its
    // own loopback Fastify. The success ack goes out only once registration is
    // complete, so an accepted dial-in is immediately usable. The registry
    // swap happens LAST: a reconnect that fails here must leave the healthy
    // prior connection and its registration untouched.
    let tunnel: ConnectionTunnel | null = null
    try {
      tunnel = await startConnectionTunnel(connection)
      await opts.onAgent({ agentId, instanceId, name, baseUrl: tunnel.url })
    } catch (err) {
      console.warn(`[iroh] registration failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
      if (tunnel) await tunnel.close().catch(() => {})
      await ackHandshake(stream, false, "registration failed")
      connection.close(5n, Array.from(Buffer.from("registration failed", "utf8")))
      agentId = "unknown"
      return
    }
    const entry: LiveConnection = { agentId, instanceId, connection }
    registry.upsert(entry)
    await ackHandshake(stream, true)
    console.log(`[iroh] agent ${agentId} (instance ${instanceId}) connected at ${tunnel.url}`)
    try {
      await connection.closed()
    } finally {
      await tunnel.close().catch(() => {})
    }
  } catch (err) {
    if (!err || typeof err !== "string") {
      // closed() rejects with non-string on transport error; log and continue.
    }
  } finally {
    if (registry.remove(agentId, instanceId, connection)) {
      console.log(`[iroh] agent ${agentId} (instance ${instanceId}) disconnected`)
      try {
        await opts.onAgentGone?.(agentId, instanceId)
      } catch (err) {
        console.warn(`[iroh] onAgentGone callback failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
