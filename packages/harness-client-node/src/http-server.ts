import http from "node:http"
import type { AddressInfo } from "node:net"
import type { ClientToolHost } from "@mira/harness-core"
import { isClientToolName, parseToolInvocation } from "@mira/harness-protocol"

export type ToolClientHttpServerOptions = {
  host: ClientToolHost
  listenHost?: string
  port?: number
  bodyLimitBytes?: number
}

export type ToolClientHttpServerAddress = {
  host: string
  port: number
  url: string
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const data = JSON.stringify(body)
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  })
  response.end(data)
}

async function readJson(request: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text.trim() ? JSON.parse(text) : null
}

export class ToolClientHttpServer {
  private readonly toolHost: ClientToolHost
  private readonly listenHost: string
  private readonly port: number
  private readonly bodyLimitBytes: number
  private readonly server: http.Server
  private address: ToolClientHttpServerAddress | null = null

  constructor(options: ToolClientHttpServerOptions) {
    this.toolHost = options.host
    this.listenHost = options.listenHost?.trim() || "0.0.0.0"
    this.port = options.port ?? 3002
    this.bodyLimitBytes = Math.max(1_024, options.bodyLimitBytes ?? 2_000_000)
    this.server = http.createServer((request, response) => void this.handle(request, response))
  }

  async start(): Promise<ToolClientHttpServerAddress> {
    if (this.address) return this.address
    await this.toolHost.start()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once("error", onError)
      this.server.listen(this.port, this.listenHost, () => {
        this.server.off("error", onError)
        resolve()
      })
    })
    const address = this.server.address() as AddressInfo
    const publicHost = this.listenHost === "0.0.0.0" || this.listenHost === "::" ? "127.0.0.1" : this.listenHost
    this.address = { host: this.listenHost, port: address.port, url: `http://${publicHost}:${address.port}` }
    return this.address
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
    }
    this.address = null
    await this.toolHost.stop()
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://client")
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          capabilities: this.toolHost.getCapabilities(),
          workspace: this.toolHost.getWorkspace(),
        })
        return
      }

      const match = /^\/tools\/([^/]+)$/.exec(url.pathname)
      const tool = match ? decodeURIComponent(match[1] ?? "") : ""
      if (request.method !== "POST" || !isClientToolName(tool)) {
        sendJson(response, 404, { error: "not found" })
        return
      }

      const invocation = parseToolInvocation(await readJson(request, this.bodyLimitBytes))
      if (!invocation || invocation.tool !== tool) {
        sendJson(response, 400, { error: "invalid tool invocation" })
        return
      }
      sendJson(response, 200, await this.toolHost.execute(invocation))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, message.includes("request body exceeds") ? 413 : 400, { error: message })
    }
  }
}
