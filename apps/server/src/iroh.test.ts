import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { EndpointTicket, SecretKey, type Connection, type Endpoint } from "@number0/iroh"
import { AWP_ALPN, bindEndpoint, deferred, openSocketStream, startConnectionTunnel } from "@niri/iroh-transport"
import { NodeToolHost, ToolClientHttpServer } from "@mira/harness-client-node"
import { HttpToolClient } from "@mira/harness-server"
import { startIrohAcceptor, type IrohAgentDialIn } from "./iroh.js"

type WorkerDial = {
  connection: Connection
  endpoint: Endpoint
}

async function dialWorker(
  ticket: string,
  handshake: Record<string, unknown>,
  role: "worker" | "client" = "worker",
): Promise<WorkerDial> {
  const endpoint = await bindEndpoint(SecretKey.generate().toBytes(), { preset: "minimal" })
  let connection: Connection | null = null
  try {
    connection = await endpoint.connect(EndpointTicket.fromString(ticket).endpointAddr(), AWP_ALPN)
    const stream = await connection.openBi()
    await stream.send.writeAll(
      Array.from(Buffer.from(`${JSON.stringify({ ...handshake, role })}\n`, "utf8")),
    )
    await stream.send.finish()
    // Mirror the worker link: read the server's JSON-line ack and throw on rejection.
    // A rejected dial-in may also arrive as a transport close racing the ack.
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
    const ackLine = ackBuffer.subarray(0, ackBuffer.indexOf("\n") >= 0 ? ackBuffer.indexOf("\n") : ackBuffer.length).toString("utf8").trim()
    const ack: unknown = ackLine ? JSON.parse(ackLine) : null
    const ackOk = ack && typeof ack === "object" && "ok" in ack && ack.ok === true
    if (!ackOk) {
      const reason = ack && typeof ack === "object" && "error" in ack ? String(ack.error) : ackLine || "no ack"
      throw new Error(`dial-in rejected: ${reason}`)
    }
    return { connection, endpoint }
  } catch (err) {
    // Never leak handles on a failed dial-in.
    connection?.close(0n, [])
    await endpoint.close().catch(() => {})
    throw err
  }
}

test("acceptor verifies tokens, gates agents, and serves the worker over the tunnel", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-acceptor-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dialIns: IrohAgentDialIn[] = []
  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    allowAgent: (agentId) => agentId === "mira",
    onAgent: (dialIn) => {
      dialIns.push(dialIn)
    },
  })
  t.after(() => handle.close())
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  // A bad token is rejected before registration.
  await assert.rejects(
    () => dialWorker(handle.ticket, { agentId: "mira", instanceId: "i1", name: "mira", token: "wrong" }),
    /dial-in rejected/,
  )
  assert.equal(dialIns.length, 0)

  // A disallowed agent id is rejected even with the right token.
  await assert.rejects(
    () => dialWorker(handle.ticket, { agentId: "nova", instanceId: "i2", name: "nova", token }),
    /dial-in rejected/,
  )
  assert.equal(dialIns.length, 0)

  // A valid dial-in registers and yields a working loopback base URL.
  const worker = await dialWorker(handle.ticket, { agentId: "mira", instanceId: "i3", name: "mira", token })
  t.after(() => worker.endpoint.close())
  t.after(() => worker.connection.close(0n, []))

  assert.equal(dialIns.length, 1)
  assert.equal(dialIns[0]!.agentId, "mira")
  assert.match(dialIns[0]!.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)

  // The registered tunnel URL serves the worker's own HTTP server.
  const app = Fastify({ logger: false })
  app.get("/health", async () => ({ ok: true, agent: "mira" }))
  await app.listen({ port: 0, host: "127.0.0.1" })
  t.after(() => app.close())
  const port = (app.server.address() as AddressInfo).port
  const stopPump = new AbortController()
  const pumpLoop = (async () => {
    while (!stopPump.signal.aborted) {
      try {
        await openSocketStream(worker.connection, port)
      } catch {
        return
      }
    }
  })()
  t.after(() => {
    stopPump.abort()
    void pumpLoop
  })

  const res = await fetch(`${dialIns[0]!.baseUrl}/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, agent: "mira" })

  stopPump.abort()
})

test("a throwing onAgent closes the tunnel instead of leaking it", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-leak-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let capturedBaseUrl: string | null = null
  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    onAgent: (dialIn) => {
      capturedBaseUrl = dialIn.baseUrl
      throw new Error("registration exploded")
    },
  })
  t.after(() => handle.close())
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  await assert.rejects(
    () => dialWorker(handle.ticket, { agentId: "mira", instanceId: "i9", name: "mira", token }),
    /dial-in rejected/,
  )
  assert.ok(capturedBaseUrl, "onAgent saw the tunnel url before throwing")

  // Probe the listener itself: a leaked tunnel would still accept TCP (and
  // only then fail on the dead QUIC connection), so only ECONNREFUSED proves
  // the port was released.
  const port = Number(new URL(capturedBaseUrl).port)
  const { promise: outcome, resolve: resolveOutcome } = deferred<string>()
  const probe = net.connect(port, "127.0.0.1")
  const timer = setTimeout(() => {
    probe.destroy()
    resolveOutcome("timeout")
  }, 2_000)
  probe.once("connect", () => {
    clearTimeout(timer)
    probe.destroy()
    resolveOutcome("connected")
  })
  probe.once("error", () => {
    clearTimeout(timer)
    resolveOutcome("refused")
  })
  assert.equal(await outcome, "refused")
})

/** Polls until a tunnel port stops accepting TCP, proving its handler tore down. */
async function waitForPortRefused(baseUrl: string): Promise<void> {
  const port = Number(new URL(baseUrl).port)
  const deadline = Date.now() + 5_000
  for (;;) {
    const { promise, resolve } = deferred<string>()
    const probe = net.connect(port, "127.0.0.1")
    probe.once("connect", () => {
      probe.destroy()
      resolve("connected")
    })
    probe.once("error", () => resolve("refused"))
    if ((await promise) === "refused") return
    if (Date.now() > deadline) throw new Error(`port ${port} still accepts connections`)
    const { promise: pause, resolve: unpause } = deferred<void>()
    setTimeout(unpause, 25)
    await pause
  }
}

test("a same-instance reconnect keeps the replacement registered", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-reconnect-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dialIns: IrohAgentDialIn[] = []
  const gone: string[] = []
  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    onAgent: (dialIn) => {
      dialIns.push(dialIn)
    },
    onAgentGone: (agentId) => {
      gone.push(agentId)
    },
  })
  t.after(() => handle.close())
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  const first = await dialWorker(handle.ticket, { agentId: "mira", instanceId: "same", name: "mira", token })
  t.after(() => first.endpoint.close())
  assert.equal(dialIns.length, 1)

  // Reconnect with the same instance id: the registry closes the old
  // connection and its cleanup must not evict this replacement.
  const second = await dialWorker(handle.ticket, { agentId: "mira", instanceId: "same", name: "mira", token })
  t.after(() => second.endpoint.close())
  t.after(() => second.connection.close(0n, []))
  assert.equal(dialIns.length, 2)
  assert.notEqual(dialIns[1]!.baseUrl, dialIns[0]!.baseUrl)

  // Wait for the old connection's teardown to fully settle (its tunnel port
  // stops listening), then prove the replacement is still registered (no
  // onAgentGone fired for it) and its tunnel serves traffic.
  await first.connection.closed().catch(() => {})
  await waitForPortRefused(dialIns[0]!.baseUrl)
  assert.deepEqual(gone, [])
})

test("a failing re-registration leaves the prior registration usable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-rereg-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dialIns: IrohAgentDialIn[] = []
  const gone: string[] = []
  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    onAgent: (dialIn) => {
      if (dialIn.instanceId === "bad") throw new Error("db exploded")
      dialIns.push(dialIn)
    },
    onAgentGone: (agentId) => {
      gone.push(agentId)
    },
  })
  t.after(() => handle.close())
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  const first = await dialWorker(handle.ticket, { agentId: "mira", instanceId: "good", name: "mira", token })
  t.after(() => first.endpoint.close())
  t.after(() => first.connection.close(0n, []))
  assert.equal(dialIns.length, 1)

  // The worker's own HTTP server, pumped over the first connection.
  const app = Fastify({ logger: false })
  app.get("/health", async () => ({ ok: true }))
  await app.listen({ port: 0, host: "127.0.0.1" })
  t.after(() => app.close())
  const port = (app.server.address() as AddressInfo).port
  const stopPump = new AbortController()
  const pumpLoop = (async () => {
    while (!stopPump.signal.aborted) {
      try {
        await openSocketStream(first.connection, port)
      } catch {
        return
      }
    }
  })()
  t.after(() => {
    stopPump.abort()
    void pumpLoop
  })

  // A reconnect whose registration blows up must not disturb the healthy one.
  await assert.rejects(
    () => dialWorker(handle.ticket, { agentId: "mira", instanceId: "bad", name: "mira", token }),
    /dial-in rejected/,
  )
  assert.equal(dialIns.length, 1)
  assert.deepEqual(gone, [])

  const res = await fetch(`${dialIns[0]!.baseUrl}/health`)
  assert.equal(res.status, 200)
  stopPump.abort()
})

test("tool client dial-in attaches to the agent tunnel and serves tool calls", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-client-link-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const gone: string[] = []

  // Mirror index.ts: an always-on tunnel waiting for a client connection.
  const tunnel = await startConnectionTunnel(null)
  t.after(() => tunnel.close())

  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    allowClient: (agentId) => agentId === "lyra",
    onClient: (dialIn) => {
      tunnel.setConnection(dialIn.connection)
    },
    onClientGone: (agentId) => {
      gone.push(agentId)
      tunnel.setConnection(null)
    },
    onAgent: () => {},
  })
  t.after(() => handle.close())
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  // The "client box": a real tool-client HTTP server on loopback.
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "niri-iroh-client-ws-"))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  await fs.writeFile(path.join(workspace, "hello.txt"), "hello through iroh\n")
  const toolHost = new NodeToolHost({ workspace: { id: "test", root: workspace } })
  const toolServer = new ToolClientHttpServer({ host: toolHost, listenHost: "127.0.0.1", port: 0 })
  const toolAddress = await toolServer.start()
  t.after(async () => {
    await toolServer.stop()
    await toolHost.stop()
  })

  // Before the client dials in, the tunnel refuses connections.
  await assert.rejects(() => fetch(`${tunnel.url}/health`))

  // The client dials out and pumps streams to its loopback tool server.
  const client = await dialWorker(handle.ticket, { agentId: "lyra", instanceId: "c1", name: "lyra", token }, "client")
  t.after(() => client.endpoint.close())
  t.after(() => client.connection.close(0n, []))
  const stopPump = new AbortController()
  const pumpLoop = (async () => {
    while (!stopPump.signal.aborted) {
      try {
        await openSocketStream(client.connection, toolAddress.port)
      } catch {
        return
      }
    }
  })()
  t.after(() => {
    stopPump.abort()
    void pumpLoop
  })

  // The worker's view: an ordinary HttpToolClient against the tunnel URL.
  const toolClient = new HttpToolClient({ agentId: "lyra", endpoint: tunnel.url })
  await toolClient.start()
  const status = toolClient.status()
  assert.equal(status.connected, true)
  assert.ok(status.capabilities.includes("read_blob"))

  const result = await toolClient.execute({
    agentId: "lyra",
    tool: "read_file",
    args: { path: path.join(workspace, "hello.txt") },
  })
  assert.equal(result.status, "ok")
  assert.match(result.output ?? "", /hello through iroh/)

  // Disconnect detaches the tunnel; it refuses again.
  stopPump.abort()
  client.connection.close(0n, [])
  await client.connection.closed().catch(() => {})
  const { promise: settled, resolve: markSettled } = deferred<void>()
  setTimeout(markSettled, 100)
  await settled
  assert.deepEqual(gone, ["lyra"])
  await assert.rejects(() => fetch(`${tunnel.url}/health`))
})
