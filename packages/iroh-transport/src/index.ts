/**
 * iroh (QUIC P2P) transport primitives shared by the niri control plane and
 * agent workers.
 *
 * The control plane (apps/server) runs an acceptor that listens for incoming
 * worker connections. Remote workers (packages/niri-runtime) dial out to the
 * server, then each side pumps raw bytes: the server exposes every live worker
 * connection as a loopback TCP tunnel (one BiStream per accepted socket), and
 * the worker pumps accepted BiStreams to its own loopback Fastify. Ordinary
 * HTTP/1.1 — including SSE — flows over iroh with zero HTTP-aware code here.
 *
 * @module @niri/iroh-transport
 */

import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { Endpoint, EndpointTicket, SecretKey, type BiStream, type Connection } from "@number0/iroh"

const AWP_ALPN_STRING = "niri/awp/0"

/** ALPN bytes that identify the niri worker↔server protocol on each QUIC connection. */
export const AWP_ALPN: number[] = Array.from(Buffer.from(AWP_ALPN_STRING, "utf8"))

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (err?: unknown) => void
}

/**
 * Node 20-compatible `Promise.withResolvers` (that API only exists on Node
 * 22+, and this repo still supports Node 20 per its engines field). The repo
 * style guide prefers `Promise.withResolvers`; this helper is the documented
 * exception wherever engine compatibility matters.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (err?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Endpoint preset: "n0" (default) adds relays + discovery for NAT traversal; "minimal" is offline-only. */
export type BindPreset = "n0" | "minimal"

export interface BindEndpointOptions {
  /**
   * Preset to apply. Defaults to `"n0"` (production relays + discovery) so the
   * endpoint can be reached across NATs. Pass `"minimal"` for tests or fully
   * offline setups that only need direct local connections.
   */
  preset?: BindPreset
}

/**
 * Load an iroh secret key from a hex file at `filePath`, or generate and
 * persist a new 32-byte key. The file is written with mode `0o600`; parent
 * directories are created with mode `0o700`. Returns the raw 32 bytes.
 */
export async function loadOrCreateSecretKey(filePath: string): Promise<number[]> {
  try {
    const text = await fs.readFile(filePath, "utf8")
    const hex = text.trim()
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("invalid iroh secret hex")
    return Array.from(Buffer.from(hex, "hex"))
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT"
    const isBadHex = err instanceof Error && err.message === "invalid iroh secret hex"
    if (!isMissing && !isBadHex) throw err
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const bytes = SecretKey.generate().toBytes()
  await fs.writeFile(filePath, Buffer.from(bytes).toString("hex"), { mode: 0o600 })
  return bytes
}

/**
 * Bind an iroh endpoint advertising the AWP ALPN. Uses the n0 production preset
 * (relays + discovery) by default so the endpoint is reachable across NATs; pass
 * `{ preset: "minimal" }` for offline-only operation. With the n0 preset we
 * wait up to 10s for `online()` (relay discovery) and then proceed regardless —
 * local direct connections work without a home relay. The minimal preset has no
 * relays, so `online()` is skipped entirely.
 */
export async function bindEndpoint(secret: number[], opts: BindEndpointOptions = {}): Promise<Endpoint> {
  const preset: BindPreset = opts.preset ?? "n0"
  const builder = Endpoint.builder()
  if (preset === "minimal") builder.applyMinimal()
  else builder.applyN0()
  builder.secretKey(secret)
  builder.alpns([AWP_ALPN])
  const endpoint = await builder.bind()
  if (preset !== "minimal") {
    try {
      const { promise, reject } = deferred<void>()
      const timer = setTimeout(() => reject(new Error("iroh endpoint.online() timed out")), 10_000)
      timer.unref?.()
      await Promise.race([endpoint.online(), promise])
      clearTimeout(timer)
    } catch (err) {
      console.warn(`[iroh] ${(err as Error).message}; proceeding (offline-friendly).`)
    }
  }
  return endpoint
}

interface PumpHandles {
  recvDone: boolean
  sendDone: boolean
  socketEnded: boolean
  settled: boolean
}

/**
 * Bidirectionally pump a BiStream against a connected TCP socket — used on
 * both sides of the tunnel. EOF and errors propagate both ways; the function
 * resolves once either side closes.
 */
export async function pipeBiStreamToSocket(stream: BiStream, socket: net.Socket): Promise<void> {
  const h: PumpHandles = { recvDone: false, sendDone: false, socketEnded: false, settled: false }

  // Writes are serialized on a promise chain so a later finish() can never
  // overtake data that is still queued (QUIC finish() would cut the tail).
  let sendChain: Promise<unknown> = Promise.resolve()
  const queueSend = (chunk: Buffer): void => {
    sendChain = sendChain.then(() => stream.send.writeAll(Array.from(chunk as Uint8Array)))
    sendChain.catch(() => settle())
  }
  const finishSend = (): void => {
    if (h.sendDone) return
    h.sendDone = true
    sendChain = sendChain.then(() => stream.send.finish())
    sendChain.catch(() => {})
  }
  const stopRecv = (): void => {
    if (h.recvDone) return
    h.recvDone = true
    stream.recv.stop(0n).catch(() => {})
  }
  const settle = (): void => {
    if (h.settled) return
    h.settled = true
    finishSend()
    stopRecv()
    if (!socket.destroyed) socket.destroy()
  }

  const recvLoop = (async () => {
    try {
      while (true) {
        const chunk = await stream.recv.read(65536)
        if (chunk.length === 0) {
          // Peer finished writing; half-close the socket's write side so the
          // HTTP server we're pumping to sees EOF. Do NOT destroy the socket —
          // it may still be sending its response back to us.
          if (!h.socketEnded && !socket.destroyed) {
            h.socketEnded = true
            socket.end()
          }
          break
        }
        if (socket.destroyed) break
        if (!socket.write(Buffer.from(chunk))) {
          const { promise, resolve } = deferred<void>()
          socket.once("drain", () => resolve())
          await promise
        }
      }
    } catch {
      settle()
    } finally {
      h.recvDone = true
    }
  })()

  socket.on("data", (chunk: Buffer) => {
    if (h.sendDone) return
    queueSend(chunk)
  })
  socket.once("end", finishSend)
  socket.once("error", () => settle())
  socket.once("close", () => {
    finishSend()
    stopRecv()
  })

  // Resolve only when the socket fully closes — that's the symmetric end of the
  // pump. The recv loop finishing early (because the peer sent EOF) must NOT
  // end the pump, since the socket may still be flushing its response.
  const { promise: socketClosed, resolve: resolveSocketClosed } = deferred<void>()
  socket.once("close", () => resolveSocketClosed())
  void recvLoop
  await socketClosed.finally(() => settle())
}

/**
 * Worker-side helper: accept the next server-initiated BiStream on `connection`
 * and pump it to a freshly-opened TCP socket on `127.0.0.1:port` (where the
 * worker's Fastify listens). Resolves once the pump completes for that stream.
 */
export async function openSocketStream(connection: Connection, port: number): Promise<void> {
  const stream = await connection.acceptBi()
  const { promise, resolve, reject } = deferred<net.Socket>()
  const s = net.connect(port, "127.0.0.1")
  const onError = (err: NodeJS.ErrnoException) => reject(err)
  s.once("connect", () => {
    s.off("error", onError)
    resolve(s)
  })
  s.once("error", onError)
  const socket = await promise
  void pipeBiStreamToSocket(stream, socket)
}

export interface DialIdentity {
  agentId: string
  instanceId: string
  name: string
  /** "worker" (default) registers an agent worker; "client" attaches a tool client. */
  role?: "worker" | "client"
}

/**
 * Dial the control plane's iroh endpoint and complete the JSON-line
 * handshake: identity + token out, ack in. Throws with the server's reason
 * when the dial-in is rejected (bad token, unknown agent, registration
 * failure), or when the transport closes before the ack arrives.
 */
export async function dialControlPlane(opts: {
  endpoint: Endpoint
  ticket: string
  token: string
  identity: DialIdentity
}): Promise<Connection> {
  const ticket = EndpointTicket.fromString(opts.ticket)
  const connection = await opts.endpoint.connect(ticket.endpointAddr(), AWP_ALPN)
  try {
    const stream = await connection.openBi()
    const handshake = JSON.stringify({
      agentId: opts.identity.agentId,
      instanceId: opts.identity.instanceId,
      name: opts.identity.name,
      token: opts.token,
      ...(opts.identity.role ? { role: opts.identity.role } : {}),
    })
    await stream.send.writeAll(Array.from(Buffer.from(`${handshake}\n`, "utf8")))
    await stream.send.finish()

    // Read the server's JSON-line ack; a rejection carries the reason, and a
    // rejected dial-in may also arrive as a transport close racing the ack.
    let ackBuffer = Buffer.alloc(0)
    try {
      for (;;) {
        const chunk = await stream.recv.read(1024)
        if (chunk.length === 0) break
        ackBuffer = Buffer.concat([ackBuffer, Buffer.from(chunk)])
        if (ackBuffer.indexOf("\n") >= 0 || ackBuffer.length > 4096) break
      }
    } catch (err) {
      throw new Error(`dial-in rejected: transport closed before ack (${err instanceof Error ? err.message : String(err)})`)
    }
    const newlineIndex = ackBuffer.indexOf("\n")
    const ackLine = ackBuffer.subarray(0, newlineIndex >= 0 ? newlineIndex : ackBuffer.length).toString("utf8").trim()
    const ack: unknown = ackLine ? JSON.parse(ackLine) : null
    const ackOk = ack && typeof ack === "object" && "ok" in ack && ack.ok === true
    if (!ackOk) {
      const reason = ack && typeof ack === "object" && "error" in ack ? String(ack.error) : ackLine || "no ack"
      throw new Error(`dial-in rejected: ${reason}`)
    }
    return connection
  } catch (err) {
    connection.close(0n, [])
    throw err
  }
}

export interface ConnectionTunnel {
  /** Loopback port the tunnel listens on. */
  port: number
  /** Loopback HTTP origin (`http://127.0.0.1:<port>`) to register as the worker's base URL. */
  url: string
  /**
   * Swap the connection new sockets will be opened on. Pass `null` to make
   * the tunnel refuse connections until a peer attaches again (e.g. a tool
   * client that dials in and out).
   */
  setConnection(connection: Connection | null): void
  /** Stop accepting, destroy in-flight sockets, and close the listener. */
  close(): Promise<void>
}

/**
 * Expose an iroh connection as a loopback TCP tunnel: every accepted socket
 * opens one BiStream on the current connection and pumps it end to end. The
 * peer is expected to pump those streams to its own loopback HTTP server, so
 * plain HTTP clients (undici, Fastify, SSE consumers) need no iroh awareness.
 * Pass `null` to create a tunnel with no peer yet, and attach one later with
 * `setConnection`.
 */
export async function startConnectionTunnel(
  connection: Connection | null,
  opts: { host?: string; port?: number } = {},
): Promise<ConnectionTunnel> {
  const host = opts.host ?? "127.0.0.1"
  const sockets = new Set<net.Socket>()
  let closed = false
  let current: Connection | null = connection
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const conn = current
    if (closed || !conn) {
      socket.destroy()
      return
    }
    conn
      .openBi()
      .then((stream) => pipeBiStreamToSocket(stream, socket))
      .catch(() => {
        if (!socket.destroyed) socket.destroy()
      })
  })
  const { promise: listening, resolve: listeningResolve, reject: listeningReject } = deferred<void>()
  server.once("error", listeningReject)
  server.listen(opts.port ?? 0, host, () => {
    server.off("error", listeningReject)
    listeningResolve()
  })
  await listening
  const address = server.address() as net.AddressInfo
  return {
    port: address.port,
    url: `http://${host}:${address.port}`,
    setConnection(next: Connection | null): void {
      current = next
    },
    close: async () => {
      closed = true
      for (const socket of sockets) socket.destroy()
      const { promise: drained, resolve: drainedResolve } = deferred<void>()
      server.close(() => drainedResolve())
      await drained
    },
  }
}
