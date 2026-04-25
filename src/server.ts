import Fastify from "fastify"
import fastifyStatic from "@fastify/static"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { wake, isRunning, isWaitingForEvent, enqueueEvent } from "./runner/index.js"
import { buildDiscordBatchDigest, scanDiscordChannels } from "./discord/state.js"
import { handleDiscordIngress } from "./discord/pipeline.js"
import { fromBsky } from "./triggers/bsky.js"
import { fromWebhook } from "./triggers/webhook.js"
import { fromCron } from "./triggers/cron.js"
import { fromChat } from "./triggers/chat.js"
import { subscribe } from "./stream.js"
import { getMetrics, getMetricDetail } from "./metrics.js"
import type { UserMessage } from "./types.js"

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const WEB_DIST_DIR = join(SRC_DIR, "..", "apps", "web", "dist")
const DISCORD_BATCH_INTERVAL_MS = Math.max(
  1_000,
  parseInt(process.env.DISCORD_BATCH_INTERVAL_MS ?? "60000", 10) || 60_000,
)
const DISCORD_BATCH_MAX_MESSAGES = Math.max(
  5,
  Math.min(200, parseInt(process.env.DISCORD_BATCH_MAX_MESSAGES ?? "40", 10) || 40),
)
const DISCORD_BATCH_SCAN = (process.env.DISCORD_BATCH_SCAN ?? "true").trim().toLowerCase() !== "false"

export function createServer() {
  const app = Fastify({ logger: false })
  let discordBatchInFlight = false
  let discordBatchTimer: ReturnType<typeof setInterval> | null = null

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

    // Kick one shortly after startup; it only emits if niri is already waiting.
    setTimeout(() => {
      void runDiscordBatch()
    }, 5_000).unref?.()
  }

  app.addHook("onClose", async () => {
    if (!discordBatchTimer) return
    clearInterval(discordBatchTimer)
    discordBatchTimer = null
  })

  if (existsSync(WEB_DIST_DIR)) {
    app.register(fastifyStatic, {
      root: WEB_DIST_DIR,
      prefix: "/ui/",
      index: false,
    })

    app.get("/ui", async (_req, reply) => reply.sendFile("index.html"))
  } else {
    app.get("/ui", async (_req, reply) => {
      reply.code(503)
      return { error: "web ui is not built yet. run `npm run build:web` first." }
    })
  }

  app.post("/trigger/discord", async (req, reply) => {
    const result = handleDiscordIngress(req.body)
    return reply.send({
      ok: true,
      ...result,
    })
  })

  app.post("/trigger/bsky", async (req, reply) => {
    const event = fromBsky(req.body)
    isRunning() ? enqueueEvent(event) : wake(event)
    return reply.send({ ok: true })
  })

  app.post("/trigger/webhook", async (req, reply) => {
    const event = fromWebhook(req.body)
    isRunning() ? enqueueEvent(event) : wake(event)
    return reply.send({ ok: true })
  })

  app.post("/trigger/cron", async (req, reply) => {
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

    // Send initial keepalive so the connection is established
    res.write(":ok\n\n")

    const unsubscribe = subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        // connection closed
      }
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
    running: isRunning(),
  }))

  app.get("/metrics", async (req) => {
    const { limit } = req.query as { limit?: string }
    return getMetrics(limit ? parseInt(limit, 10) : 100)
  })

  app.get("/metrics/:id", async (req, reply) => {
    const { id } = req.params as { id: string }
    const metric = getMetricDetail(parseInt(id, 10))
    if (!metric) return reply.code(404).send({ error: "metric not found" })
    return metric
  })

  return app
}
