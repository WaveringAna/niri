import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { SecretKey, type Connection } from "@number0/iroh"
import { bindEndpoint, dialControlPlane } from "@niri/iroh-transport"
import { startIrohAcceptor } from "./iroh"
import { acceptClientReverseRpc } from "./client-reverse-rpc"

type Hit = { method: string; url: string; authorization?: string; body: string }

function record(url: string): { baseUrl: string; lastSeq: number } {
  return { baseUrl: url, lastSeq: 0 }
}

function startHttpServer(label: string, hits: Hit[]): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
    hits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      body: Buffer.concat(chunks).toString("utf8"),
    })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ agent: label, url: req.url }))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

/**
 * Send one raw HTTP request over a fresh client-opened BiStream and read the
 * whole reply. The send side is finished only after the response arrives, the
 * way a real HTTP client behaves: half-closing first would make Node's HTTP
 * server drop the connection before an asynchronous answer is written.
 */
async function roundTrip(connection: Connection, raw: string): Promise<string> {
  const stream = await connection.openBi()
  await stream.send.writeAll(Array.from(Buffer.from(raw, "utf8")))
  let response = Buffer.alloc(0)
  for (;;) {
    const chunk = await stream.recv.read(65536)
    if (chunk.length === 0) break
    response = Buffer.concat([response, Buffer.from(chunk)])
  }
  await stream.send.finish().catch(() => {})
  return response.toString("utf8")
}

function request(method: string, target: string, body?: string): string {
  const head = [`${method} ${target} HTTP/1.1`, "host: worker", "connection: close"]
  if (body !== undefined) head.push("content-type: application/json", `content-length: ${Buffer.byteLength(body)}`)
  return `${head.join("\r\n")}\r\n\r\n${body ?? ""}`
}

async function startBridge(t: import("node:test").TestContext): Promise<{ connection: Connection; hitsA: Hit[]; hitsB: Hit[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-client-reverse-rpc-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const hitsA: Hit[] = []
  const hitsB: Hit[] = []
  const serverA = await startHttpServer("agent-a", hitsA)
  const serverB = await startHttpServer("agent-b", hitsB)
  t.after(() => new Promise<void>((resolve) => { serverA.close(() => resolve()); serverB.close(() => resolve()) }))
  const urlA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`
  const urlB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`
  const agents = new Map<string, ReturnType<typeof record>>([
    ["agent-a", record(urlA)],
    ["agent-b", record(urlB)],
  ])

  let current = true
  const handle = await startIrohAcceptor({
    secretFile: path.join(dir, "iroh.secret"),
    tokenFile: path.join(dir, "iroh.token"),
    preset: "minimal",
    allowClient: (agentId) => agents.has(agentId),
    onAgent: () => {},
    onClient: (dialIn) => {
      void acceptClientReverseRpc(dialIn, {
        getAgent: (agentId) => {
          const entry = agents.get(agentId)
          return entry ? { id: agentId, name: agentId, baseUrl: entry.baseUrl, status: "online", lastSeq: entry.lastSeq } : null
        },
        isCurrent: () => current,
      })
    },
  })
  t.after(async () => { current = false; await handle.close() })
  const token = (await fs.readFile(path.join(dir, "iroh.token"), "utf8")).trim()

  const endpoint = await bindEndpoint(SecretKey.generate().toBytes(), { preset: "minimal" })
  t.after(() => endpoint.close().catch(() => {}))
  const connection = await dialControlPlane({
    endpoint,
    ticket: handle.ticket,
    token,
    identity: { agentId: "agent-a", instanceId: "ca", name: "agent-a", role: "client" },
  })
  t.after(() => connection.close(0n, []))
  return { connection, hitsA, hitsB }
}

test("client reverse RPC forwards POST /host-rpc to the bound agent only", async (t) => {
  const { connection, hitsA, hitsB } = await startBridge(t)

  const call = JSON.stringify({ type: "host.call", method: "memory.list" })
  const response = await roundTrip(
    connection,
    `POST /host-rpc HTTP/1.1\r\nhost: worker\r\nconnection: close\r\nauthorization: Bearer grant-1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(call)}\r\n\r\n${call}`,
  )

  assert.match(response, /^HTTP\/1\.1 200 /)
  assert.match(response, /"agent":"agent-a"/)
  assert.deepEqual(hitsA, [{ method: "POST", url: "/host-rpc", authorization: "Bearer grant-1", body: call }])
  assert.deepEqual(hitsB, [])
})

test("client reverse RPC rejects every route and method other than POST /host-rpc", async (t) => {
  const { connection, hitsA, hitsB } = await startBridge(t)

  const rejected: Array<[string, RegExp]> = [
    [request("GET", "/host-rpc"), /^HTTP\/1\.1 405 /],
    [request("GET", "/awp/status"), /^HTTP\/1\.1 405 /],
    [request("POST", "/awp/status", "{}"), /^HTTP\/1\.1 404 /],
    [request("POST", "/anything", "{}"), /^HTTP\/1\.1 404 /],
    [request("DELETE", "/host-rpc"), /^HTTP\/1\.1 405 /],
    // A query string must not smuggle a different target past the path check.
    [request("POST", "/awp/status?/host-rpc", "{}"), /^HTTP\/1\.1 404 /],
  ]
  for (const [raw, expected] of rejected) {
    assert.match(await roundTrip(connection, raw), expected, `expected rejection for: ${raw.split("\r\n")[0]}`)
  }

  // Nothing reached either runtime: the ingress answered on its own.
  assert.deepEqual(hitsA, [])
  assert.deepEqual(hitsB, [])

  // The one allowed shape still works after the refusals.
  assert.match(await roundTrip(connection, request("POST", "/host-rpc", "{}")), /"agent":"agent-a"/)
  assert.deepEqual(hitsA.map((hit: Hit) => `${hit.method} ${hit.url}`), ["POST /host-rpc"])
})

test("client reverse RPC refuses oversized bodies before forwarding", async (t) => {
  const { connection, hitsA } = await startBridge(t)

  const body = JSON.stringify({ pad: "x".repeat(600_000) })
  const response = await roundTrip(connection, request("POST", "/host-rpc", body))
  assert.match(response, /^HTTP\/1\.1 413 /)
  assert.deepEqual(hitsA, [])
})

test("client reverse RPC answers 413 for chunked bodies crossing the limit mid-stream", async (t) => {
  const { connection, hitsA } = await startBridge(t)

  // No content-length: the limit is only crossed while the body streams in,
  // so the refusal path must drain (not destroy) to get the 413 back.
  const body = JSON.stringify({ pad: "x".repeat(600_000) })
  const head = [
    "POST /host-rpc HTTP/1.1",
    "host: worker",
    "connection: close",
    "content-type: application/json",
    "transfer-encoding: chunked",
  ].join("\r\n")
  const framed: string[] = []
  for (let i = 0; i < body.length; i += 100_000) {
    const piece = body.slice(i, i + 100_000)
    framed.push(`${piece.length.toString(16)}\r\n${piece}\r\n`)
  }
  framed.push("0\r\n\r\n")

  const response = await roundTrip(connection, `${head}\r\n\r\n${framed.join("")}`)
  assert.match(response, /^HTTP\/1\.1 413 /)
  assert.deepEqual(hitsA, [])
})
