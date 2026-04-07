import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js"
import { handleDiscordIngress } from "./pipeline.js"

function asEnabled(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "false" || normalized === "0" || normalized === "no") return false
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true
  return fallback
}

function buildIngressPayload(message: Message): Record<string, unknown> {
  const channelName =
    message.channel && "name" in message.channel && typeof message.channel.name === "string"
      ? message.channel.name
      : null

  return {
    message: {
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId ?? null,
      channel_type: message.channel?.type ?? null,
      content: message.content ?? "",
      timestamp: message.createdAt.toISOString(),
      message_reference: message.reference?.messageId
        ? {
            message_id: message.reference.messageId,
            channel_id: message.reference.channelId ?? message.channelId,
            guild_id: message.reference.guildId ?? message.guildId ?? null,
          }
        : null,
      author: {
        id: message.author.id,
        username: message.author.username,
        global_name: message.author.globalName ?? null,
        bot: message.author.bot,
      },
      mentions: message.mentions.users.map((u) => ({
        id: u.id,
        bot: u.bot,
      })),
    },
    channel: {
      id: message.channelId,
      type: message.channel?.type ?? null,
      guild_id: message.guildId ?? null,
      name: channelName,
    },
    is_dm: message.guildId == null,
  }
}

export type DiscordGatewayHandle = {
  stop: () => Promise<void>
}

export async function startDiscordGateway(): Promise<DiscordGatewayHandle | null> {
  const enabled = asEnabled(process.env.DISCORD_GATEWAY_ENABLED, true)
  const trace = asEnabled(process.env.DISCORD_GATEWAY_TRACE, false)
  const rawFallback = asEnabled(process.env.DISCORD_GATEWAY_RAW_FALLBACK, true)
  if (!enabled) {
    console.log("[discord gateway] disabled via DISCORD_GATEWAY_ENABLED=false")
    return null
  }

  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) {
    console.log("[discord gateway] DISCORD_BOT_TOKEN not set; gateway listener disabled")
    return null
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })

  if (trace) {
    console.log("[discord gateway] trace enabled")
  }

  client.once(Events.ClientReady, (ready) => {
    if (!process.env.DISCORD_BOT_USER_ID && ready.user?.id) {
      process.env.DISCORD_BOT_USER_ID = ready.user.id
    }
    console.log(
      `[discord gateway] connected as ${ready.user?.tag ?? ready.user?.id ?? "unknown"} (id=${ready.user?.id ?? "unknown"})`,
    )
  })

  client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
    if (packet?.t !== "MESSAGE_CREATE") return
    if (!rawFallback) return
    const d = packet.d ?? {}
    const author = (d.author ?? {}) as Record<string, unknown>
    let ingestResultText = ""
    try {
      const result = handleDiscordIngress(d)
      ingestResultText = ` ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`
    } catch (err) {
      ingestResultText = ` ingest_error=${err instanceof Error ? err.message : String(err)}`
    }

    if (trace) {
      console.log(
        `[discord gateway/raw] MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${String(d.channel_id ?? "unknown")} guild=${String(d.guild_id ?? "dm")} author=${String(author.username ?? author.id ?? "unknown")} bot=${String(Boolean(author.bot))}${ingestResultText}`,
      )
    }
  })

  client.on(Events.MessageCreate, (message) => {
    try {
      const payload = buildIngressPayload(message)
      const result = handleDiscordIngress(payload)
      if (trace) {
        const channelType = typeof message.channel?.type === "number" ? message.channel.type : null
        const isDm = message.guildId == null
        console.log(
          `[discord gateway] messageCreate id=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} type=${channelType ?? "unknown"} is_dm=${isDm} ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`,
        )
      }
    } catch (err) {
      console.warn("[discord gateway] failed to ingest message:", err)
    }
  })

  client.on(Events.Error, (err) => {
    console.warn("[discord gateway] client error:", err)
  })

  await client.login(token)

  return {
    stop: async () => {
      await client.destroy()
      console.log("[discord gateway] disconnected")
    },
  }
}
