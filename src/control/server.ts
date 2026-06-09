import Fastify from "fastify"
import type { FastifyInstance, FastifyReply } from "fastify"
import fastifyStatic from "@fastify/static"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CORS_HEADERS, applyCorsHeaders } from "../cors"
import { setWebUiCacheHeaders } from "../static-ui"
import {
  getAgent,
  listAgents,
  listMirroredEvents,
  listRecentCompactions,
  recordWorkerEvent,
  upsertAgent,
  updateAgentStatus,
} from "./db"
import type { ControlCommand, WorkerEvent } from "../awp/types"
import type { UserMessage } from "../types"

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const WEB_DIST_DIR = join(SRC_DIR, "..", "..", "apps", "web", "dist")

function agentAuthHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchWorkerJson(agent: { baseUrl: string; token?: string }, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${agent.baseUrl}${path}`, {
    ...init,
    headers: {
      ...agentAuthHeaders(agent.token),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  const data = parseJsonOrText(text)
  if (!res.ok) {
    const detail = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : text
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return data
}

function looksLikeWorkerEvent(value: unknown): value is WorkerEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<WorkerEvent>
  return (
    typeof event.id === "string" &&
    typeof event.agentId === "string" &&
    typeof event.seq === "number" &&
    typeof event.type === "string" &&
    typeof event.createdAt === "string"
  )
}

function normalizeWorkerEvent(event: WorkerEvent, agentId?: string): WorkerEvent {
  if (!agentId || event.agentId === agentId) return event
  return { ...event, agentId }
}

function mirrorWorkerEvent(raw: unknown, agentId?: string): void {
  if (!looksLikeWorkerEvent(raw)) return
  recordWorkerEvent(normalizeWorkerEvent(raw, agentId))
}

function mirrorWorkerEvents(raw: unknown, agentId?: string): void {
  if (!raw || typeof raw !== "object" || !("events" in raw)) return
  const events = (raw as { events?: unknown }).events
  if (!Array.isArray(events)) return
  for (const event of events) mirrorWorkerEvent(event, agentId)
}

function compactWorkerEventForChat(raw: unknown): WorkerEvent | null {
  if (!looksLikeWorkerEvent(raw)) return null
  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {}

  if (raw.type === "conversation.started" || raw.type === "conversation.ended") return raw

  if (raw.type === "stream.event") {
    const type = typeof payload.type === "string" ? payload.type : ""
    if (type !== "user") return null
    return {
      ...raw,
      payload: {
        type,
        source: payload.source,
        text: payload.text,
        triggeredAt: payload.triggeredAt,
        clientId: payload.clientId,
      },
    }
  }

  if (raw.type !== "conversation.message") return null

  const role = typeof payload.role === "string" ? payload.role : ""
  const content = typeof payload.content === "string" ? payload.content : ""
  if (!content.trim()) return null
  if (role === "user" && content.trim().startsWith("[wake]")) return null
  if (role === "user" && content.trim().startsWith("[incoming")) return null
  if (role !== "assistant" && role !== "tool" && role !== "user") return null

  return {
    ...raw,
    payload: {
      role,
      content: role === "tool" ? compactText(content, 2400) : content,
      createdAt: payload.createdAt,
    },
  }
}

function compactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n... truncated for the control panel ...`
}

function compactEventsForChat(events: unknown[]): WorkerEvent[] {
  const compacted: WorkerEvent[] = []
  for (const event of events) {
    const compact = compactWorkerEventForChat(event)
    if (compact) compacted.push(compact)
  }
  return compacted
}

function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const rest = parts.pop() ?? ""
  return { blocks: parts, rest }
}

function mirrorSseBlock(block: string, agentId?: string): void {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
  if (dataLines.length === 0) return

  try {
    mirrorWorkerEvent(JSON.parse(dataLines.join("\n")), agentId)
  } catch {
    // Ignore malformed upstream data; the raw SSE still reaches clients.
  }
}

async function proxyWorkerStream(agentId: string, reply: FastifyReply, afterSeq: number): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) {
    reply.code(404).send({ error: "agent not found" })
    return
  }

  reply.hijack()

  const downstream = reply.raw
  downstream.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...CORS_HEADERS,
  })
  downstream.write(":ok\n\n")

  let res: Response
  const controller = new AbortController()
  downstream.on("close", () => controller.abort())
  try {
    res = await fetch(`${agent.baseUrl}/awp/stream?after_seq=${afterSeq}`, {
      headers: agentAuthHeaders(agent.token),
      signal: controller.signal,
    })
  } catch (err) {
    downstream.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`)
    downstream.end()
    return
  }

  if (!res.ok || !res.body) {
    downstream.write(`event: error\ndata: ${JSON.stringify({ error: `${res.status} ${res.statusText}` })}\n\n`)
    downstream.end()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (!downstream.destroyed) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      downstream.write(chunk)
      buffer += chunk
      const parsed = splitSseBlocks(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) mirrorSseBlock(block, agentId)
    }
  } catch (err) {
    if (!downstream.destroyed && !(err instanceof Error && err.name === "AbortError")) {
      downstream.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`)
    }
  } finally {
    controller.abort()
    reader.releaseLock()
    if (!downstream.destroyed) downstream.end()
  }
}

function chatEventFromBody(agentId: string, body: unknown): UserMessage | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const content = typeof b.content === "string" ? b.content.trim() : ""
  if (!content) return null
  return {
    source: "chat",
    triggeredAt: new Date().toISOString(),
    content,
    raw: body,
    clientId: typeof b.clientId === "string" ? b.clientId : `control-${agentId}`,
  }
}

export function registerControlRoutes(app: FastifyInstance, options: { staticUi?: boolean } = {}) {
  if (options.staticUi !== false && existsSync(WEB_DIST_DIR)) {
    app.register(fastifyStatic, {
      root: WEB_DIST_DIR,
      prefix: "/ui/",
      index: "index.html",
      cacheControl: false,
      setHeaders: setWebUiCacheHeaders,
    })

    app.get("/ui", async (_req, reply) => {
      setWebUiCacheHeaders(reply.raw)
      return reply.sendFile("index.html", { cacheControl: false })
    })
  } else if (options.staticUi !== false) {
    app.get("/ui", async (_req, reply) => {
      reply.code(503)
      return { error: "web ui is not built yet. run `npm run build:web` first." }
    })
  }

  app.get("/agents", async () => ({
    agents: listAgents().map(({ token: _token, ...agent }) => agent),
  }))

  app.post("/agents", async (req, reply) => {
    const body = req.body as Record<string, unknown>
    try {
      const agent = upsertAgent({
        id: String(body.id ?? ""),
        name: typeof body.name === "string" ? body.name : undefined,
        baseUrl: String(body.baseUrl ?? body.base_url ?? ""),
        token: typeof body.token === "string" ? body.token : undefined,
      })
      const { token: _token, ...safeAgent } = agent
      return reply.send({ ok: true, agent: safeAgent })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/agents/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    try {
      const status = await fetchWorkerJson(agent, "/awp/status")
      updateAgentStatus(id, "online")
      return status
    } catch (err) {
      updateAgentStatus(id, "offline")
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/agents/:id/overview", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    let workerStatus: unknown = null
    try {
      workerStatus = await fetchWorkerJson(agent, "/awp/status")
      updateAgentStatus(id, "online")
    } catch (err) {
      updateAgentStatus(id, "offline")
      workerStatus = { error: err instanceof Error ? err.message : String(err) }
    }

    const { token: _token, ...safeAgent } = getAgent(id) ?? agent
    return {
      agent: safeAgent,
      status: workerStatus,
      compactions: listRecentCompactions(id, 12),
    }
  })

  app.post("/agents/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Partial<ControlCommand> | Record<string, unknown>)
        : {}
    let command: ControlCommand
    if ("type" in body && body.type === "event.enqueue") {
      command = body as ControlCommand
    } else {
      const event = chatEventFromBody(id, body)
      if (!event) return reply.code(400).send({ error: "expected content or event.enqueue command" })
      command = {
        type: "event.enqueue",
        event,
      }
    }

    if (command.type !== "event.enqueue" || !command.event) {
      return reply.code(400).send({ error: "expected content or event.enqueue command" })
    }

    try {
      const previousLastSeq = agent.lastSeq
      const result = await fetchWorkerJson(agent, "/awp/events", {
        method: "POST",
        body: JSON.stringify(command),
      })
      try {
        const remote = await fetchWorkerJson(agent, `/awp/events?after_seq=${previousLastSeq}&limit=1000`)
        mirrorWorkerEvents(remote, id)
      } catch (err) {
        console.warn(`[control] failed to sync events from ${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      updateAgentStatus(id, "online")
      return result
    } catch (err) {
      updateAgentStatus(id, "offline")
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/agents/:id/shutdown", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    try {
      const result = await fetchWorkerJson(agent, "/awp/shutdown", { method: "POST" })
      updateAgentStatus(id, "online")
      return result
    } catch (err) {
      updateAgentStatus(id, "offline")
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/agents/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })
    const query = req.query as { after_seq?: string; limit?: string; tail?: string; view?: string }
    const afterSeq = Number.parseInt(query.after_seq ?? "0", 10) || 0
    const limit = Number.parseInt(query.limit ?? "500", 10) || 500
    const mode = query.tail === "1" || query.tail === "true" ? "tail" : "after"

    try {
      const remote =
        mode === "tail"
          ? await fetchWorkerJson(agent, `/awp/events?tail=1&limit=${limit}`)
          : await fetchWorkerJson(agent, `/awp/events?after_seq=${afterSeq}&limit=${limit}`)
      mirrorWorkerEvents(remote, id)
      updateAgentStatus(id, "online")
    } catch (err) {
      updateAgentStatus(id, "offline")
      console.warn(`[control] failed to sync events from ${id}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const events = listMirroredEvents(
      id,
      afterSeq,
      limit,
      mode,
    )

    return {
      agentId: id,
      events: query.view === "chat" ? compactEventsForChat(events) : events,
    }
  })

  app.get("/agents/:id/compactions", async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!getAgent(id)) return reply.code(404).send({ error: "agent not found" })
    const query = req.query as { limit?: string }
    return {
      agentId: id,
      compactions: listRecentCompactions(id, Number.parseInt(query.limit ?? "20", 10) || 20),
    }
  })

  app.get("/agents/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { after_seq?: string }
    await proxyWorkerStream(id, reply, Number.parseInt(query.after_seq ?? "0", 10) || 0)
  })

  app.get("/health", async () => ({ ok: true }))
}

export function createControlServer() {
  const app = Fastify({ logger: false })

  app.addHook("onRequest", async (_req, reply) => {
    applyCorsHeaders(reply)
  })

  app.options("/*", async (_req, reply) => reply.code(204).send())

  registerControlRoutes(app)

  return app
}
