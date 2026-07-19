import Fastify from "fastify"
import type { FastifyInstance, FastifyReply } from "fastify"
import { createHmac, timingSafeEqual } from "node:crypto"
import fastifyStatic from "@fastify/static"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setWebUiCacheHeaders } from "./static-ui"
import {
  getAgent,
  listAgents,
  listMirroredEvents,
  listRecentCompactions,
  recordWorkerEvent,
  updateAgentStatus,
} from "./db"
import type { ControlCommand, UserMessage, WorkerEvent } from "@niri/protocol"
import type { WebhookConfig } from "../local-agents"

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const WEB_DIST_DIR = join(SRC_DIR, "..", "..", "..", "web", "dist")

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchWorkerJson(agent: { baseUrl: string }, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${agent.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  const data = parseJsonOrText(text)
  if (!res.ok) {
    const detail = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : text
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return data
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, config: WebhookConfig): boolean {
  const prefix = config.signaturePrefix ?? "sha256="
  if (!signature?.startsWith(prefix)) return false
  const suppliedHex = signature.slice(prefix.length)
  if (!/^[0-9a-fA-F]{64}$/.test(suppliedHex)) return false
  const expected = createHmac("sha256", config.secret).update(rawBody).digest()
  const supplied = Buffer.from(suppliedHex, "hex")
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
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
  } catch {}
}

async function proxyWorkerStream(
  agentId: string,
  reply: FastifyReply,
  afterSeq: number,
  configuredAgentIds?: ReadonlySet<string>,
): Promise<void> {
  const agent = configuredAgentIds && !configuredAgentIds.has(agentId) ? null : getAgent(agentId)
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
  })
  downstream.write(":ok\n\n")

  let res: Response
  const controller = new AbortController()
  downstream.on("close", () => controller.abort())
  try {
    res = await fetch(`${agent.baseUrl}/awp/stream?after_seq=${afterSeq}`, {
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

export function registerControlRoutes(
  app: FastifyInstance,
  options: {
    staticUi?: boolean
    configuredAgentIds?: ReadonlySet<string>
    stopLocalAgent?: (id: string) => Promise<boolean>
    webhooks?: ReadonlyMap<string, Readonly<Record<string, WebhookConfig>>>
  } = {},
) {
  const findAgent = (id: string) => options.configuredAgentIds && !options.configuredAgentIds.has(id) ? null : getAgent(id)
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
    agents: listAgents().filter((agent) => !options.configuredAgentIds || options.configuredAgentIds.has(agent.id)),
  }))

  app.get("/agents/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
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
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    let workerStatus: unknown = null
    try {
      workerStatus = await fetchWorkerJson(agent, "/awp/status")
      updateAgentStatus(id, "online")
    } catch (err) {
      updateAgentStatus(id, "offline")
      workerStatus = { error: err instanceof Error ? err.message : String(err) }
    }

    return {
      agent: findAgent(id) ?? agent,
      status: workerStatus,
      compactions: listRecentCompactions(id, 12),
    }
  })

  app.post("/agents/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
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
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })

    try {
      if (await options.stopLocalAgent?.(id)) {
        updateAgentStatus(id, "offline")
        return reply.send({ ok: true, agentId: id, shuttingDown: true })
      }
      const result = await fetchWorkerJson(agent, "/awp/shutdown", { method: "POST" })
      updateAgentStatus(id, "online")
      return result
    } catch (err) {
      updateAgentStatus(id, "offline")
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/agents/:id/trigger/cron", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })
    try {
      const result = await fetchWorkerJson(agent, "/trigger/cron", {
        method: "POST",
        body: JSON.stringify(req.body ?? {}),
      })
      updateAgentStatus(id, "online")
      return reply.send(result)
    } catch (err) {
      updateAgentStatus(id, "offline")
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.register(async (webhookRoutes) => {
    webhookRoutes.removeContentTypeParser("application/json")
    webhookRoutes.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
      try {
        done(null, { rawBody: body, payload: JSON.parse(body.toString("utf8")) })
      } catch (error) {
        done(error as Error, undefined)
      }
    })

    webhookRoutes.post("/agents/:id/trigger/webhook/:name", async (req, reply) => {
      const { id, name } = req.params as { id: string; name: string }
      const agent = findAgent(id)
      if (!agent) return reply.code(404).send({ error: "agent not found" })
      const config = options.webhooks?.get(id)?.[name]
      if (!config) return reply.code(404).send({ error: "webhook not found" })

      const body = req.body as { rawBody: Buffer; payload: unknown }
      const header = config.signatureHeader ?? "x-niri-signature"
      const headerValue = req.headers[header]
      const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue
      if (!verifyWebhookSignature(body.rawBody, signature, config)) {
        return reply.code(401).send({ error: "invalid webhook signature" })
      }

      const event: UserMessage = {
        source: "webhook",
        triggeredAt: new Date().toISOString(),
        content: `[webhook triggered: ${name}]`,
        raw: { webhook: { name }, payload: body.payload },
      }
      try {
        const result = await fetchWorkerJson(agent, "/awp/events", {
          method: "POST",
          body: JSON.stringify({ type: "event.enqueue", event } satisfies ControlCommand),
        })
        updateAgentStatus(id, "online")
        return reply.send(result)
      } catch (error) {
        updateAgentStatus(id, "offline")
        return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) })
      }
    })
  })

  app.get("/agents/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
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
    if (!findAgent(id)) return reply.code(404).send({ error: "agent not found" })
    const query = req.query as { limit?: string }
    return {
      agentId: id,
      compactions: listRecentCompactions(id, Number.parseInt(query.limit ?? "20", 10) || 20),
    }
  })

  app.get("/agents/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { after_seq?: string }
    await proxyWorkerStream(id, reply, Number.parseInt(query.after_seq ?? "0", 10) || 0, options.configuredAgentIds)
  })

  app.get("/agents/:id/client/status", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })
    try {
      return reply.send(await fetchWorkerJson(agent, "/awp/client/status"))
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/agents/:id/discord/channels", async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })
    try {
      return reply.send(await fetchWorkerJson(agent, "/discord/channels"))
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/agents/:id/discord/channels/:channelId/messages", async (req, reply) => {
    const { id, channelId } = req.params as { id: string; channelId: string }
    const agent = findAgent(id)
    if (!agent) return reply.code(404).send({ error: "agent not found" })
    const query = req.query as { before?: string; limit?: string }
    const params = new URLSearchParams()
    if (query.before) params.set("before", query.before)
    if (query.limit) params.set("limit", query.limit)
    try {
      return reply.send(await fetchWorkerJson(agent, `/discord/channels/${encodeURIComponent(channelId)}/messages?${params}`))
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/health", async () => ({ ok: true }))
}

export function createControlServer(options: {
  configuredAgentIds?: ReadonlySet<string>
  stopLocalAgent?: (id: string) => Promise<boolean>
  webhooks?: ReadonlyMap<string, Readonly<Record<string, WebhookConfig>>>
} = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 })

  app.options("/*", async (_req, reply) => reply.code(204).send())

  registerControlRoutes(app, {
    configuredAgentIds: options.configuredAgentIds,
    stopLocalAgent: options.stopLocalAgent,
    webhooks: options.webhooks,
  })

  return app
}
