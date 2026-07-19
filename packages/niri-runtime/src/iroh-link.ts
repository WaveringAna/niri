import { randomUUID } from "node:crypto"
import path from "node:path"
import { EndpointTicket, type Connection, type Endpoint } from "@number0/iroh"
import {
  AWP_ALPN,
  bindEndpoint,
  loadOrCreateSecretKey,
  openSocketStream,
} from "@niri/iroh-transport"
import { AGENT_ID, NIRI_HOME } from "./agent-config"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const SERVER_IROH_TICKET = process.env.NIRI_SERVER_IROH_TICKET?.trim()
const SERVER_IROH_TOKEN = process.env.NIRI_SERVER_IROH_TOKEN?.trim()
const INSTANCE_ID = process.env.NIRI_WORKER_INSTANCE_ID?.trim() || randomUUID()
const AGENT_NAME = process.env.AGENT_NAME?.trim() || AGENT_ID

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

interface LinkState {
  endpoint: Endpoint | null
  connection: Connection | null
  abort: AbortController | null
}

const state: LinkState = {
  endpoint: null,
  connection: null,
  abort: null,
}

let linkStarted = false

function secretFilePath(): string {
  return path.join(NIRI_HOME, "state", "iroh.secret")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

function encodeHandshake(): number[] {
  const payload = JSON.stringify({
    agentId: AGENT_ID,
    instanceId: INSTANCE_ID,
    name: AGENT_NAME,
    token: SERVER_IROH_TOKEN,
  }) + "\n"
  return Array.from(Buffer.from(payload, "utf8"))
}

/**
 * Connect to the control-plane iroh endpoint named by `NIRI_SERVER_IROH_TICKET`,
 * send the JSON-line handshake on the first BiStream, then forever accept
 * server-initiated BiStreams and pump each to `127.0.0.1:PORT` (where this
 * worker's Fastify listens). On connection failure or close, retries with
 * exponential backoff (1s→30s).
 *
 * No-op when `NIRI_SERVER_IROH_TICKET` is unset (purely local worker).
 */
export async function startIrohLink(): Promise<void> {
  if (linkStarted) return
  if (!SERVER_IROH_TICKET || !SERVER_IROH_TOKEN) return
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) return
  linkStarted = true

  const abort = new AbortController()
  state.abort = abort
  const secret = await loadOrCreateSecretKey(secretFilePath())
  const endpoint = await bindEndpoint(secret)
  state.endpoint = endpoint
  void runConnectLoop(endpoint, abort.signal).catch((err) => {
    console.warn(`[iroh-link] connect loop crashed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function runConnectLoop(endpoint: Endpoint, signal: AbortSignal): Promise<void> {
  let firstSuccess = true
  let delay = RECONNECT_MIN_MS
  while (!signal.aborted) {
    let connection: Connection | null = null
    try {
      const ticket = EndpointTicket.fromString(SERVER_IROH_TICKET!)
      connection = await endpoint.connect(ticket.endpointAddr(), AWP_ALPN)
      const handshakeStream = await connection.openBi()
      await handshakeStream.send.writeAll(encodeHandshake())
      await handshakeStream.send.finish()
      // Read the server's JSON-line ack; a rejection carries the reason, and a
      // rejected dial-in may also arrive as a transport close racing the ack.
      let ackBuffer = Buffer.alloc(0)
      try {
        for (;;) {
          const chunk = await handshakeStream.recv.read(1024)
          if (chunk.length === 0) break
          ackBuffer = Buffer.concat([ackBuffer, Buffer.from(chunk)])
          if (ackBuffer.indexOf("\n") >= 0 || ackBuffer.length > 4096) break
        }
      } catch (err) {
        throw new Error(`dial-in rejected: transport closed before ack (${err instanceof Error ? err.message : String(err)})`)
      }
      const ackLine = ackBuffer.subarray(0, ackBuffer.indexOf("\n") >= 0 ? ackBuffer.indexOf("\n") : ackBuffer.length).toString("utf8").trim()
      const ack: unknown = ackLine ? JSON.parse(ackLine) : null
      const ackOk = ack && typeof ack === "object" && "ok" in ack && ack.ok === true
      if (!ackOk) {
        const reason = ack && typeof ack === "object" && "error" in ack ? String(ack.error) : ackLine || "no ack"
        throw new Error(`dial-in rejected: ${reason}`)
      }
      state.connection = connection
      if (firstSuccess) {
        console.log(`[iroh-link] connected to control plane as ${AGENT_ID} (instance ${INSTANCE_ID})`)
        firstSuccess = false
      } else {
        console.info(`[iroh-link] reconnected to control plane as ${AGENT_ID}`)
      }
      delay = RECONNECT_MIN_MS
      await pumpStreamsUntilClosed(connection, signal)
      state.connection = null
    } catch (err) {
      if (signal.aborted) return
      console.warn(`[iroh-link] connect/pump failed (retry in ${delay}ms): ${err instanceof Error ? err.message : String(err)}`)
      await sleep(delay)
      delay = Math.min(RECONNECT_MAX_MS, delay * 2)
    }
  }
}

async function pumpStreamsUntilClosed(connection: Connection, signal: AbortSignal): Promise<void> {
  const closedP = connection.closed()
  while (!signal.aborted) {
    const raceOutcome = await Promise.race([
      openSocketStream(connection, PORT).then(() => "pumped" as const),
      closedP.then(() => "closed" as const),
    ]).catch(() => "closed" as const)
    if (raceOutcome === "closed") return
  }
}

/**
 * Stop the iroh link and close its endpoint. Safe to call multiple times; safe
 * to call when {@link startIrohLink} was a no-op (no `NIRI_SERVER_IROH_TICKET`).
 */
export async function stopIrohLink(): Promise<void> {
  const abort = state.abort
  if (abort) abort.abort()
  state.abort = null
  const conn = state.connection
  state.connection = null
  if (conn) {
    try {
      conn.close(0n, Array.from(Buffer.from("worker shutdown", "utf8")))
    } catch {
      /* ignore */
    }
  }
  const endpoint = state.endpoint
  state.endpoint = null
  if (endpoint) {
    try {
      await endpoint.close()
    } catch {
      /* ignore */
    }
  }
}
