import http from "node:http"
import type { AddressInfo, Socket } from "node:net"
import type { Connection, BiStream } from "@number0/iroh"
import { deferred, pipeBiStreamToPort } from "@niri/iroh-transport"
import { getAgent, type AgentRecord } from "./control/db"

/** The single route a client dial-in may reach on its agent's runtime. */
export const HOST_RPC_PATH = "/host-rpc"
/** Request bodies above this are refused at the ingress, before any forwarding. */
export const HOST_RPC_INGRESS_BODY_LIMIT_BYTES = 512_000
/** Upper bound on one forwarded call; matches the runtime's maximum grant window. */
const HOST_RPC_UPSTREAM_TIMEOUT_MS = 10 * 60_000

export type ClientReverseRpcDialIn = {
  agentId: string
  connection: Connection
}

export type ClientReverseRpcOptions = {
  /** Resolve the authenticated agent to a loopback worker origin. Defaults to the control DB. */
  getAgent?: (agentId: string) => AgentRecord | null
  /** Gate that keeps one accept loop alive until its connection is replaced/closed. */
  isCurrent?: (agentId: string, connection: Connection) => boolean
  /** Optional error hook (defaults to no-op) so tests and callers can observe bridge failure. */
  onError?: (agentId: string, error: unknown) => void
}

export type HostRpcIngress = {
  /** Loopback port reverse streams are pumped to. */
  port: number
  close: () => Promise<void>
}

function resetStream(stream: BiStream): void {
  stream.send.finish().catch(() => {})
  stream.recv.stop(1n).catch(() => {})
}

/** Loopback http origin of an agent's runtime, or null when it is unusable as a target. */
function loopbackOrigin(agent: AgentRecord | null): { host: string; port: number } | null {
  if (!agent) return null
  let target: URL
  try {
    target = new URL(agent.baseUrl)
  } catch {
    return null
  }
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) return null
  const port = Number.parseInt(target.port || "80", 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: target.hostname, port }
}

function refuse(res: http.ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { "content-type": "application/json", connection: "close" })
  res.end(JSON.stringify({ error: message }))
}

/**
 * Read a bounded request body. Resolves null (after answering 413) once the
 * client exceeds the limit, so an oversized body is never buffered whole.
 * A chunked request that crosses the limit mid-stream is drained to its end
 * before the 413 is sent — answering earlier would close the socket with
 * body bytes still in flight, and the response can be lost to a reset.
 */
async function readBoundedBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10)
  if (Number.isFinite(declared) && declared > HOST_RPC_INGRESS_BODY_LIMIT_BYTES) {
    req.resume()
    refuse(res, 413, `host RPC request exceeds ${HOST_RPC_INGRESS_BODY_LIMIT_BYTES} bytes`)
    return null
  }
  const chunks: Buffer[] = []
  let total = 0
  let refused = false
  try {
    for await (const chunk of req) {
      total += (chunk as Buffer).length
      if (total > HOST_RPC_INGRESS_BODY_LIMIT_BYTES) {
        // Stop buffering, keep draining without storing anything.
        refused = true
        chunks.length = 0
        continue
      }
      if (!refused) chunks.push(Buffer.from(chunk as Buffer))
    }
  } catch (error) {
    if (!refused) throw error
    return null // the client hung up mid-drain; there is nobody left to answer
  }
  if (refused) {
    refuse(res, 413, `host RPC request exceeds ${HOST_RPC_INGRESS_BODY_LIMIT_BYTES} bytes`)
    return null
  }
  return Buffer.concat(chunks)
}

/** Forward one validated call to the agent runtime's `/host-rpc` and relay the answer verbatim. */
function forwardHostRpc(
  origin: { host: string; port: number },
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
  res: http.ServerResponse,
  onError: (error: unknown) => void,
): void {
  const upstream = http.request(
    { host: origin.host, port: origin.port, method: "POST", path: HOST_RPC_PATH, headers },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, {
        "content-type": upstreamResponse.headers["content-type"] ?? "application/json",
        connection: "close",
      })
      upstreamResponse.pipe(res)
    },
  )
  upstream.setTimeout(HOST_RPC_UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("host RPC upstream timed out")))
  upstream.once("error", (error) => {
    onError(error)
    if (!res.headersSent) refuse(res, 502, `host RPC upstream unavailable: ${error instanceof Error ? error.message : String(error)}`)
    else res.destroy()
  })
  upstream.end(body)
}

/**
 * Loopback ingress that exposes exactly one route — `POST /host-rpc` on the
 * agent bound to the dial-in — and nothing else of the agent runtime. Reverse
 * streams are pumped here instead of straight at the runtime port, so an
 * authenticated client connection grants the right to invoke that agent's host
 * RPC, not HTTP reach into its runtime.
 */
export async function startHostRpcIngress(
  agentId: string,
  resolveAgent: (agentId: string) => AgentRecord | null,
  onError: (error: unknown) => void = () => {},
): Promise<HostRpcIngress> {
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0]
      if (req.method !== "POST") {
        req.resume()
        refuse(res, 405, "host RPC ingress accepts POST only")
        return
      }
      if (path !== HOST_RPC_PATH) {
        req.resume()
        refuse(res, 404, `host RPC ingress exposes ${HOST_RPC_PATH} only`)
        return
      }
      const body = await readBoundedBody(req, res)
      if (!body) return
      // Resolved per request: a client may attach before its managed runtime is
      // ready, and later calls must use the agent's current route.
      const origin = loopbackOrigin(resolveAgent(agentId))
      if (!origin) {
        refuse(res, 502, `no loopback runtime is bound to agent ${agentId}`)
        return
      }
      forwardHostRpc(
        origin,
        {
          "content-type": req.headers["content-type"] ?? "application/json",
          "content-length": body.length,
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body,
        res,
        onError,
      )
    })().catch((error) => {
      onError(error)
      if (!res.headersSent) refuse(res, 500, "host RPC ingress failed")
      else res.destroy()
    })
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const { promise: listening, resolve, reject } = deferred<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject)
    resolve()
  })
  await listening
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      const { promise: closed, resolve: closedResolve } = deferred<void>()
      server.close(() => closedResolve())
      await closed
    },
  }
}

/**
 * Pump client-opened BiStreams to the host-RPC ingress bound to the
 * authenticated agent id. This is the reverse half of the iroh link: outer
 * host->client tool requests use server-opened streams, while nested
 * client->host RPC uses independently client-opened streams. The route is
 * always derived from the dial-in identity, never from request contents, and
 * the ingress admits `POST /host-rpc` only.
 */
export async function acceptClientReverseRpc(dialIn: ClientReverseRpcDialIn, options: ClientReverseRpcOptions = {}): Promise<void> {
  const resolveAgent = options.getAgent ?? getAgent
  const isCurrent = options.isCurrent ?? (() => true)
  const report = (error: unknown) => {
    try { options.onError?.(dialIn.agentId, error) } catch { /* hook errors are non-fatal */ }
  }
  const closed = dialIn.connection.closed()
  const ingress = await startHostRpcIngress(dialIn.agentId, resolveAgent, report)
  try {
    while (isCurrent(dialIn.agentId, dialIn.connection)) {
      const accepted = await Promise.race([
        dialIn.connection.acceptBi().then((stream) => ({ type: "stream" as const, stream })),
        closed.then(() => ({ type: "closed" as const })),
      ]).catch(() => ({ type: "closed" as const }))
      if (accepted.type === "closed") return
      if (!isCurrent(dialIn.agentId, dialIn.connection)) {
        resetStream(accepted.stream)
        return
      }
      void pipeBiStreamToPort(accepted.stream, ingress.port).catch(report)
    }
  } finally {
    await ingress.close().catch(() => {})
  }
}
