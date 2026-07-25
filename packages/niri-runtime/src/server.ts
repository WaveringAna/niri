import Fastify from "fastify"
import { AGENT_ID } from "./agent-config"
import { clientTools } from "./client"
import { listWorkerEvents, publishWorkerEvent, subscribeWorkerEvents } from "./awp/outbox"
import type { ControlCommand } from "./awp/types"
import { wake, isRunning, isWaitingForEvent, enqueueEvent, getRunnerStatus } from "./runner/index"
import { buildDiscordBatchDigest, scanDiscordChannels } from "./discord/state"
import { handleDiscordIngress } from "./discord/pipeline"
import { fromBsky } from "./triggers/bsky"
import { fromCron } from "./triggers/cron"
import { fromChat } from "./triggers/chat"
import { subscribe } from "./stream"
import { getMetrics, getMetricDetail, getDiscordMetricDetail } from "./metrics"
import { parseChannelIds } from "./discord/parse"
import { queryChannelMessages, queryChannels } from "./discord/db"
import type { MetricListType } from "./metrics"
import type { UserMessage } from "./types"
import { activeContextSummaries, describeContextSummary } from "./runner/context-store"
import { loadSession } from "./runner/util"

const DISCORD_BATCH_INTERVAL_MS = Math.max(
  1_000,
  parseInt(process.env.DISCORD_BATCH_INTERVAL_MS ?? "60000", 10) || 60_000,
)
const DISCORD_BATCH_MAX_MESSAGES = Math.max(
  5,
  Math.min(200, parseInt(process.env.DISCORD_BATCH_MAX_MESSAGES ?? "40", 10) || 40),
)
const DISCORD_BATCH_SCAN = (process.env.DISCORD_BATCH_SCAN ?? "true").trim().toLowerCase() !== "false"
const METRIC_LIST_TYPES = new Set<MetricListType>(["response", "summarization", "memory", "prompt", "usage", "discord"])
const METRIC_TYPE_ALIASES: Record<string, MetricListType> = {
  compaction: "summarization",
  memory: "memory",
  memories: "memory",
  summary: "summarization",
  summaries: "summarization",
  response: "response",
  prompt_response: "response",
  "prompt-response": "response",
  completion: "response",
}
const TRIGGER_SOURCES = new Set(["discord", "bsky", "webhook", "cron", "chat"])

function parseMetricTypes(raw: string | undefined): MetricListType[] | undefined {
  if (!raw?.trim()) return undefined

  const types: MetricListType[] = []
  for (const item of raw.split(",")) {
    const normalized = item.trim().toLowerCase()
    const type = METRIC_TYPE_ALIASES[normalized] ?? normalized
    if (!METRIC_LIST_TYPES.has(type as MetricListType)) continue
    if (!types.includes(type as MetricListType)) types.push(type as MetricListType)
  }
  return types.length ? types : undefined
}

export function createServer(options: { requestRestart?: (reason?: string) => void; requestShutdown?: () => void } = {}) {
  const imageMaxBytes = Math.max(1, Number.parseInt(process.env.IMAGE_TOOL_MAX_BYTES ?? "1000000", 10) || 1_000_000)
  const app = Fastify({ logger: false, bodyLimit: Math.max(2_000_000, imageMaxBytes * 2 + 1_000_000) })
  let discordBatchInFlight = false
  let discordBatchTimer: ReturnType<typeof setInterval> | null = null

  app.options("/*", async (_req, reply) => reply.code(204).send())
  app.get("/health", async () => ({
    ok: true,
    agentId: AGENT_ID,
    instanceId: process.env.NIRI_WORKER_INSTANCE_ID?.trim() || null,
  }))

  const runDiscordBatch = async (): Promise<void> => {
    if (discordBatchInFlight) return
    discordBatchInFlight = true
    try {
      if (!isRunning()) return
      if (!isWaitingForEvent()) return

      if (DISCORD_BATCH_SCAN) {
        await scanDiscordChannels({ limit: DISCORD_BATCH_MAX_MESSAGES })
      }

      const digest = buildDiscordBatchDigest({
        maxMessages: DISCORD_BATCH_MAX_MESSAGES,
        intervalMs: DISCORD_BATCH_INTERVAL_MS,
      })
      if (!digest) return

      enqueueEvent(
        {
          source: "discord",
          triggeredAt: new Date().toISOString(),
          content: digest.content,
          raw: {
            type: "discord_batch",
            digest,
            source: "gateway_cache",
          },
        },
        { onlyIfWaiting: true },
      )
    } catch (err) {
      console.warn("[discord batch] failed:", err instanceof Error ? err.message : String(err))
    } finally {
      discordBatchInFlight = false
    }
  }

  const hasDiscordToken = Boolean(process.env.DISCORD_BOT_TOKEN?.trim())
  if (hasDiscordToken) {
    discordBatchTimer = setInterval(() => {
      void runDiscordBatch()
    }, DISCORD_BATCH_INTERVAL_MS)
    if (typeof discordBatchTimer.unref === "function") discordBatchTimer.unref()

    setTimeout(() => {
      void runDiscordBatch()
    }, 5_000).unref?.()
  }

  app.addHook("onClose", async () => {
    if (!discordBatchTimer) return
    clearInterval(discordBatchTimer)
    discordBatchTimer = null
  })

  publishWorkerEvent("worker.hello", {
    agentId: AGENT_ID,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })

  function isUserMessage(value: unknown): value is UserMessage {
    if (!value || typeof value !== "object") return false
    const event = value as Partial<UserMessage>
    return (
      typeof event.content === "string" &&
      typeof event.triggeredAt === "string" &&
      typeof event.source === "string" &&
      TRIGGER_SOURCES.has(event.source)
    )
  }

  function dispatchEvent(event: UserMessage, options: { onlyIfWaiting?: boolean; priority?: boolean } = {}): boolean {
    if (isRunning()) return enqueueEvent(event, options)
    if (options.onlyIfWaiting) return false
    void wake(event)
    return true
  }

  app.get("/awp/status", async () => ({
    agentId: AGENT_ID,
    ...getRunnerStatus(),
    client: clientTools.status(),
  }))

  app.get("/awp/client/status", async () => clientTools.status())

  app.get("/awp/context/dag", async () => {
    const session = await loadSession() ?? []
    const frontier = activeContextSummaries(session).map(({ id, depth }) => {
      const described = describeContextSummary(id)
      return described ? { id, depth, summary: described.summary } : { id, depth, summary: null }
    })
    return { agentId: AGENT_ID, frontier }
  })

  app.get("/awp/context/dag/:summaryId", async (req, reply) => {
    const { summaryId } = req.params as { summaryId: string }
    if (!/^sum_[0-9a-f-]+$/.test(summaryId)) return reply.code(400).send({ error: "invalid summary id" })
    const described = describeContextSummary(summaryId)
    if (!described) return reply.code(404).send({ error: "summary not found" })
    return { agentId: AGENT_ID, node: described }
  })

  app.post("/awp/events", async (req, reply) => {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Partial<ControlCommand> | UserMessage)
        : ({} as Partial<ControlCommand>)
    const isEnqueueCommand = "type" in body && body.type === "event.enqueue"
    const event = isEnqueueCommand ? body.event : body
    const options = isEnqueueCommand ? body.options : undefined

    if (!isUserMessage(event)) {
      return reply.code(400).send({ error: "expected a UserMessage or event.enqueue command" })
    }

    const accepted = dispatchEvent(event, options)
    return reply.send({
      ok: accepted,
      agentId: AGENT_ID,
      running: isRunning(),
    })
  })

  app.get("/awp/events", async (req) => {
    const query = req.query as { after_seq?: string; limit?: string; tail?: string }
    const mode = query.tail === "1" || query.tail === "true" ? "tail" : "after"
    return {
      agentId: AGENT_ID,
      events: listWorkerEvents(
        Number.parseInt(query.after_seq ?? "0", 10) || 0,
        Number.parseInt(query.limit ?? "500", 10) || 500,
        mode,
      ),
    }
  })

  app.post("/awp/shutdown", async (_req, reply) => {
    if (!options.requestShutdown) return reply.code(503).send({ error: "process shutdown is not available" })
    options.requestShutdown()
    return reply.send({ ok: true, agentId: AGENT_ID, shuttingDown: true })
  })

  app.post("/awp/restart", async (req, reply) => {
    if (!options.requestRestart) {
      return reply.code(503).send({ error: "restart is not available in this process" })
    }

    const body = req.body && typeof req.body === "object" ? (req.body as { reason?: unknown }) : {}
    const reason = typeof body.reason === "string" ? body.reason : undefined
    options.requestRestart(reason)
    return reply.send({ ok: true, agentId: AGENT_ID, restarting: true })
  })

  app.get("/awp/stream", (req, reply) => {
    const query = req.query as { after_seq?: string; limit?: string }
    const afterSeq = Math.max(0, Number.parseInt(query.after_seq ?? "0", 10) || 0)
    const limit = Math.max(1, Math.min(1000, Number.parseInt(query.limit ?? "500", 10) || 500))

    reply.hijack()

    const res = reply.raw
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })

    res.write(":ok\n\n")

    const liveBuffer: ReturnType<typeof listWorkerEvents> = []
    let replaying = true
    let lastSeq = afterSeq
    const seenIds = new Set<string>()

    const send = (event: ReturnType<typeof listWorkerEvents>[number]) => {
      if (seenIds.has(event.id)) return
      seenIds.add(event.id)
      if (event.seq > 0) lastSeq = Math.max(lastSeq, event.seq)
      try {
        res.write(`id: ${event.seq}\n`)
        res.write(`event: ${event.type}\n`)
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {}
    }

    const unsubscribe = subscribeWorkerEvents((event) => {
      if (replaying) {
        liveBuffer.push(event)
        return
      }
      send(event)
    })

    try {
      for (const event of listWorkerEvents(afterSeq, limit)) send(event)
    } catch (err) {
      send(
        publishWorkerEvent("worker.heartbeat", {
          error: `failed to replay worker events: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
    }

    replaying = false
    for (const event of liveBuffer.sort((a, b) => a.seq - b.seq)) {
      if (event.seq === 0 || event.seq > lastSeq || !seenIds.has(event.id)) send(event)
    }

    const keepalive = setInterval(() => {
      try {
        publishWorkerEvent("worker.heartbeat", {
          agentId: AGENT_ID,
          running: isRunning(),
          idle: isWaitingForEvent(),
        })
        res.write(":ping\n\n")
      } catch {
        clearInterval(keepalive)
        unsubscribe()
      }
    }, 15_000)

    req.raw.on("close", () => {
      clearInterval(keepalive)
      unsubscribe()
    })
  })

  app.post("/trigger/discord", async (req, reply) => {
    const result = handleDiscordIngress(req.body)
    return reply.send({
      ok: true,
      ...result,
    })
  })

  app.get("/discord/channels", async () => ({
    agentId: AGENT_ID,
    channels: queryChannels(parseChannelIds()),
  }))

  app.get("/discord/channels/:channelId/messages", async (req) => {
    const { channelId } = req.params as { channelId: string }
    const query = req.query as { before?: string; limit?: string }
    const limit = Math.max(1, Math.min(200, Number.parseInt(query.limit ?? "100", 10) || 100))
    return {
      agentId: AGENT_ID,
      channelId,
      messages: queryChannelMessages(channelId, query.before ?? "", limit).map(({ raw_json: _rawJson, ...message }) => message),
    }
  })

  app.post("/trigger/bsky", async (req, reply) => {
    const event = fromBsky(req.body)
    isRunning() ? enqueueEvent(event) : wake(event)
    return reply.send({ ok: true })
  })

  app.post("/trigger/restart", async (req, reply) => {
    if (!options.requestRestart) {
      return reply.code(503).send({ error: "restart is not available in this process" })
    }

    const body = req.body && typeof req.body === "object" ? (req.body as { reason?: unknown }) : {}
    const reason = typeof body.reason === "string" ? body.reason : "webhook restart"
    options.requestRestart(reason)
    return reply.send({ ok: true, restarting: true })
  })

  app.post("/trigger/cron", async (_req, reply) => {
    const event = fromCron()
    isRunning() ? enqueueEvent(event) : wake(event)
    return reply.send({ ok: true })
  })

  app.post("/trigger/chat", async (req, reply) => {
    const event = fromChat(req.body)
    if (!event.content.trim()) {
      return reply.code(400).send({ error: "content is required" })
    }
    isRunning() ? enqueueEvent(event) : wake(event)
    return reply.send({ ok: true, running: true })
  })

  app.get("/chat/stream", (req, reply) => {
    reply.hijack()

    const res = reply.raw
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })

    res.write(":ok\n\n")

    const unsubscribe = subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {}
    })

    const keepalive = setInterval(() => {
      try {
        res.write(":ping\n\n")
      } catch {
        clearInterval(keepalive)
        unsubscribe()
      }
    }, 15_000)

    req.raw.on("close", () => {
      clearInterval(keepalive)
      unsubscribe()
    })
  })

  app.get("/status", async () => ({
    ...getRunnerStatus(),
  }))

  app.get("/metrics", async (req) => {
    const query = req.query as {
      limit?: string
      cursor?: string
      type?: string
      includeRaw?: string
      q?: string
      from?: string
      to?: string
      cursor_memories?: string
      cursor_summarization?: string
      cursor_response?: string
      cursor_prompt?: string
      cursor_usage?: string
      cursor_discord?: string
    }
    return getMetrics({
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      cursor: query.cursor ? parseInt(query.cursor, 10) : undefined,
      cursors: {
        memories: query.cursor_memories,
        summarization: query.cursor_summarization,
        response: query.cursor_response,
        prompt: query.cursor_prompt,
        usage: query.cursor_usage,
        discord: query.cursor_discord,
      },
      type: parseMetricTypes(query.type),
      includeRaw: query.includeRaw === "true" || query.includeRaw === "1",
      q: query.q,
      from: query.from,
      to: query.to,
    })
  })

  app.get("/metrics/discord/:id", async (req, reply) => {
    const { id } = req.params as { id: string }
    const metric = getDiscordMetricDetail(id)
    if (!metric) return reply.code(404).send({ error: "discord metric not found" })
    return metric
  })

  app.get("/metrics/:id", async (req, reply) => {
    const { id } = req.params as { id: string }
    const metric = getMetricDetail(parseInt(id, 10))
    if (!metric) return reply.code(404).send({ error: "metric not found" })
    return metric
  })

  return app
}
