import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import test from "node:test"
import { EndpointTicket, SecretKey, type Connection, type Endpoint as EndpointType } from "@number0/iroh"
import Fastify from "fastify"
import {
  AWP_ALPN,
  bindEndpoint,
  loadOrCreateSecretKey,
  openSocketStream,
  pipeBiStreamToSocket,
  startConnectionTunnel,
} from "./index.js"

/** Offline-friendly endpoint using the minimal preset (no relay needed). */
async function bindMinimal(secret: number[]): Promise<EndpointType> {
  return bindEndpoint(secret, { preset: "minimal" })
}

/**
 * Register an acceptNext on `endpoint` and resolve with the resulting Connection.
 * Deterministic: the promise must be set up before connect() is called so the
 * incoming is not missed.
 */
async function acceptOne(endpoint: EndpointType): Promise<Connection> {
  const incoming = await endpoint.acceptNext()
  if (!incoming) throw new Error("acceptNext returned null")
  return incoming.accept().then((a) => a.connect())
}

test("loadOrCreateSecretKey round-trips a generated hex secret", async (t) => {
  const dir = await fs.mkdtemp("/tmp/iroh-secret-")
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = `${dir}/iroh.secret`

  const first = await loadOrCreateSecretKey(file)
  assert.equal(first.length, 32)
  const second = await loadOrCreateSecretKey(file)
  assert.deepEqual(second, first)
})

test("BiStream↔Socket pump mirrors bytes both ways and closes on EOF", async () => {
  const serverEp = await bindMinimal(SecretKey.generate().toBytes())
  const workerEp = await bindMinimal(SecretKey.generate().toBytes())
  const ticket = EndpointTicket.fromAddr(serverEp.addr())

  const acceptedP = acceptOne(serverEp)
  const workerConn = await workerEp.connect(ticket.endpointAddr(), AWP_ALPN)
  const serverConn = await acceptedP

  const echo = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk))
    socket.on("end", () => socket.end())
  })
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
  const port = (echo.address() as net.AddressInfo).port

  // Register server's acceptBi before awaiting worker's openBi. The iroh data
  // path delivers a BiStream reliably only once data has been written to it
  // (the BI frame goes out with the first STREAM frame), so we writeAll right
  // after openBi resolves, THEN await the server's accept.
  const serverBiP = serverConn.acceptBi()
  const workerBi = await workerConn.openBi()
  await workerBi.send.writeAll(Array.from(Buffer.from("ping", "utf8")))
  const serverBi = await serverBiP

  const socket = net.connect(port, "127.0.0.1")
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  const pumpP = pipeBiStreamToSocket(serverBi, socket)

  // recv.read returns whatever is available (up to N bytes); do not use
  // readToEnd, which would deadlock waiting for an EOF the echo server never
  // sends until we finish our own send.
  const back = await workerBi.recv.read(64)
  assert.equal(Buffer.from(back).toString("utf8"), "ping")

  await workerBi.send.finish()
  await pumpP
  echo.close()
  await serverEp.close()
  await workerEp.close()
})

test("connection tunnel carries plain HTTP (GET, POST, SSE) over iroh", async (t) => {
  const serverEp = await bindMinimal(SecretKey.generate().toBytes())
  const workerEp = await bindMinimal(SecretKey.generate().toBytes())
  t.after(async () => {
    await serverEp.close().catch(() => {})
    await workerEp.close().catch(() => {})
  })
  const ticket = EndpointTicket.fromAddr(serverEp.addr())

  const acceptedP = acceptOne(serverEp)
  const workerConn = await workerEp.connect(ticket.endpointAddr(), AWP_ALPN)
  const serverConn = await acceptedP

  const app = Fastify({ logger: false })
  app.get("/json", async () => ({ hello: "world" }))
  app.post("/echo", async (req) => {
    const body: unknown = req.body
    const text = body && typeof body === "object" && "text" in body ? body.text : null
    return { echoed: text }
  })
  // SSE endpoint emits three ticks then closes the stream — exercises the
  // tunnel's read-until-EOF framing with a real HTTP client. Real timer is
  // intentional: the interval drives the simulated event stream; the test
  // awaits the response body, not the clock.
  app.get("/stream", (_req, reply) => {
    reply.hijack()
    const downstream = reply.raw
    downstream.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    })
    let i = 0
    const timer = setInterval(() => {
      downstream.write(`data: tick-${i}\n\n`)
      i += 1
      if (i >= 3) {
        clearInterval(timer)
        downstream.end()
      }
    }, 5)
  })
  await app.listen({ port: 0, host: "127.0.0.1" })
  t.after(() => app.close())
  const workerPort = (app.server.address() as net.AddressInfo).port

  // Worker side: pump every server-initiated stream to loopback Fastify.
  const stopWorker = new AbortController()
  const workerLoop = (async () => {
    while (!stopWorker.signal.aborted) {
      try {
        await openSocketStream(workerConn, workerPort)
      } catch {
        return
      }
    }
  })()
  t.after(() => {
    stopWorker.abort()
    void workerLoop
  })

  // Server side: every tunnel socket opens one BiStream; plain fetch does the rest.
  const tunnel = await startConnectionTunnel(serverConn)
  t.after(() => tunnel.close())

  const getRes = await fetch(`${tunnel.url}/json`)
  assert.equal(getRes.status, 200)
  assert.deepEqual(await getRes.json(), { hello: "world" })

  const postRes = await fetch(`${tunnel.url}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  })
  assert.equal(postRes.status, 200)
  assert.deepEqual(await postRes.json(), { echoed: "hi" })

  const streamRes = await fetch(`${tunnel.url}/stream`)
  assert.equal(streamRes.status, 200)
  const text = await streamRes.text()
  assert.match(text, /data: tick-0/)
  assert.match(text, /data: tick-2/)

  stopWorker.abort()
  workerConn.close(0n, [])
  serverConn.close(0n, [])
})
