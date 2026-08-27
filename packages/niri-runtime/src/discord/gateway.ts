import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js"
import { handleDiscordIngress } from "./pipeline"
import { getPosture, POSTURE_DEFINITIONS, subscribePosture, type Posture } from "./posture"
import { subscribeRunnerPresence, type RunnerPresence } from "../runner/presence"
import { handleGastownMessage, installGastownMirror, isGastownThread, uninstallGastownMirror } from "./gastown"

export function asEnabled(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "false" || normalized === "0" || normalized === "no") return false
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true
  return fallback
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function buildIngressPayload(message: Message): Record<string, unknown> {
  const channelName =
    message.channel && "name" in message.channel && typeof message.channel.name === "string"
      ? message.channel.name
      : null
  const channelTopic =
    message.channel && "topic" in message.channel && typeof message.channel.topic === "string"
      ? message.channel.topic
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
      member: message.member
        ? {
            nickname: message.member.nickname ?? null,
            display_name: message.member.displayName ?? null,
          }
        : null,
      mentions: message.mentions.users.map((u) => {
        const member = message.mentions.members?.get(u.id) ?? message.guild?.members.cache.get(u.id)
        return {
          id: u.id,
          username: u.username,
          global_name: u.globalName ?? null,
          nickname: member?.nickname ?? null,
          display_name: member?.displayName ?? null,
          bot: u.bot,
        }
      }),
      attachments: message.attachments.map((a) => ({
        id: a.id,
        url: a.url,
        proxy_url: a.proxyURL,
        filename: a.name,
        content_type: a.contentType ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        size: a.size,
      })),
    },
    channel: {
      id: message.channelId,
      type: message.channel?.type ?? null,
      guild_id: message.guildId ?? null,
      name: channelName,
      topic: channelTopic,
    },
    guild_name: message.guild?.name ?? null,
    is_dm: message.guildId == null,
  }
}

export type DiscordGatewayHandle = {
  stop: () => Promise<void>
}

async function updateGuildBios(client: Client, bio: string): Promise<void> {
  await Promise.all(
    Array.from(client.guilds.cache.values()).map(async (guild) => {
      try {
        // discord.js's Routes.guildMember helper percent-encodes @me, but
        // Discord's current-member bio route requires the literal @me path.
        const response = await client.rest.patch(`/guilds/${guild.id}/members/@me`, { body: { bio } })
        if (!response || typeof response !== "object" || !("bio" in response) || response.bio !== bio) {
          throw new Error("Discord did not return the requested guild bio")
        }
      } catch (err) {
        console.warn(`[discord gateway] failed to update bio in guild ${guild.id}:`, err)
      }
    }),
  )
}

async function setDiscordPresence(client: Client, _presence: RunnerPresence): Promise<void> {
  if (!client.user) return

  try {
    const posture = getPosture()
    const definition = POSTURE_DEFINITIONS[posture]
    await client.user.setPresence(
      {
        status: posture === "forge" ? "dnd" : "online",
        activities: [
          {
            name: definition.status,
            state: definition.bio,
            type: ActivityType.Custom,
          },
        ],
      },
    )
    await updateGuildBios(client, definition.bio)
  } catch (err) {
    console.warn("[discord gateway] failed to update presence:", err)
  }
}

export async function startDiscordGateway(): Promise<DiscordGatewayHandle | null> {
  const enabled = asEnabled(process.env.DISCORD_GATEWAY_ENABLED, true)
  const trace = asEnabled(process.env.DISCORD_GATEWAY_TRACE, false)
  const rawFallback = asEnabled(process.env.DISCORD_GATEWAY_RAW_FALLBACK, true)
  const rawFallbackAll = asEnabled(process.env.DISCORD_GATEWAY_RAW_FALLBACK_ALL, false)
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

  let latestPresence: RunnerPresence = "resting"
  let unsubscribePresence: (() => void) | null = null
  let unsubscribePosture: (() => void) | null = null

  const refreshPresence = () => {
    if (client.isReady()) void setDiscordPresence(client, latestPresence)
  }

  client.once(Events.ClientReady, (ready) => {
    if (!process.env.DISCORD_BOT_USER_ID && ready.user?.id) {
      process.env.DISCORD_BOT_USER_ID = ready.user.id
    }
    console.log(
      `[discord gateway] connected as ${ready.user?.tag ?? ready.user?.id ?? "unknown"} (id=${ready.user?.id ?? "unknown"})`,
    )
    void setDiscordPresence(client, latestPresence)
  })

  unsubscribePresence = subscribeRunnerPresence((presence) => {
    latestPresence = presence
    refreshPresence()
  })
  unsubscribePosture = subscribePosture((_posture: Posture) => {
    refreshPresence()
  })

  client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
    if (packet?.t !== "MESSAGE_CREATE") return
    if (!rawFallback) return
    const d = packet.d ?? {}
    const channelId = asString(d.channel_id)
    if (channelId && isGastownThread(channelId)) return
    const guildId = asString(d.guild_id)
    const channelType = asNumber(d.channel_type)
    const cachedChannel = channelId ? client.channels.cache.get(channelId) : null
    const cachedType = typeof cachedChannel?.type === "number" ? cachedChannel.type : null
    const isDm =
      !guildId &&
      (channelType == null ||
        channelType === ChannelType.DM ||
        channelType === ChannelType.GroupDM ||
        cachedType === ChannelType.DM ||
        cachedType === ChannelType.GroupDM)

    if (!rawFallbackAll && !isDm) {
      if (trace) {
        console.log(
          `[discord gateway/raw] ignored MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${channelId || "unknown"} guild=${guildId || "none"} type=${channelType ?? cachedType ?? "unknown"} reason=not_dm_fallback`,
        )
      }
      return
    }

    const author = (d.author ?? {}) as Record<string, unknown>
    let ingestResultText = ""
    try {
      const result = handleDiscordIngress({
        ...d,
        is_dm: isDm,
      })
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

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (await handleGastownMessage(message)) return
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
  await installGastownMirror()

  return {
    stop: async () => {
      uninstallGastownMirror()
      unsubscribePresence?.()
      unsubscribePosture?.()
      await client.destroy()
      console.log("[discord gateway] disconnected")
    },
  }
}
