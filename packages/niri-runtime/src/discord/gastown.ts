import { createHash } from "node:crypto"
import { Routes, type Message } from "discord.js"
import { makeRestClient, withDiscordRestRetry } from "./rest"
import {
  handleDiscordDelegationMessage,
  setDelegationMirror,
  type DelegationMirror,
} from "../delegation/manager"
import { getDelegatedTaskByThread, type DelegatedTask, type DelegatedTaskMessage } from "../delegation/store"

const FORUM_CHANNEL_ID = process.env.DISCORD_GASTOWN_FORUM_CHANNEL_ID?.trim() || ""
const GASTOWN_WEBHOOK_NAME = "niri gastown workers"
let guildId: string | null = null

type GastownWebhook = {
  id: string
  token: string
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function threadName(task: DelegatedTask): string {
  const status = task.status === "completed"
    ? "done"
    : task.status === "needs_input"
      ? "input"
      : task.status === "failed"
        ? "failed"
        : task.status === "cancelled"
          ? "cancelled"
          : task.status === "interrupted"
            ? "interrupted"
            : task.profile
  return truncate(`[${status}] ${task.objective}`.replace(/\s+/g, " ").trim(), 100)
}

function chunks(content: string): string[] {
  const result: string[] = []
  let remaining = content
  while (remaining.length > 2000) {
    let split = remaining.lastIndexOf("\n", 2000)
    if (split < 1000) split = 2000
    result.push(remaining.slice(0, split))
    remaining = remaining.slice(split).replace(/^\n/, "")
  }
  if (remaining) result.push(remaining)
  return result
}

function initialPost(task: DelegatedTask): string {
  return [
    `task: ${task.id}`,
    `status: ${task.status}`,
    `requested by: ${task.createdByName || task.createdByKind}`,
    "",
    "**objective**",
    task.objective,
    "",
    "every human member of this private server is equally authorized to observe and steer this task. ordinary replies go to the worker; mention niri to include her too.",
  ].join("\n")
}

function mirroredPost(task: DelegatedTask, message: DelegatedTaskMessage): string {
  if (message.senderKind === "subagent") return `**${message.kind}**\n\n${message.content}`
  const heading = `${message.senderName} → ${task.profile} · ${message.kind}`
  return `**${heading}**\n\n${message.content}`
}

function identiconUrl(task: DelegatedTask): string {
  const hash = createHash("md5")
    .update(`niri-gastown:${task.profile}:${task.id}`)
    .digest("hex")
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&f=y&s=128`
}

function webhookIdentity(task: DelegatedTask) {
  return {
    username: truncate(task.profile, 80),
    avatar_url: identiconUrl(task),
  }
}

function webhookThreadRequest(webhook: GastownWebhook, task: DelegatedTask) {
  return {
    route: Routes.webhook(webhook.id, webhook.token),
    query: new URLSearchParams({ wait: "true" }),
    body: {
      ...webhookIdentity(task),
      thread_name: threadName(task),
      content: truncate(initialPost(task), 2000),
      allowed_mentions: { parse: [] },
    },
  }
}

function webhookMessageRequest(webhook: GastownWebhook, task: DelegatedTask, content: string) {
  return {
    route: Routes.webhook(webhook.id, webhook.token),
    query: new URLSearchParams({ wait: "true", thread_id: task.discordThreadId! }),
    body: {
      ...webhookIdentity(task),
      content,
      allowed_mentions: { parse: [] },
    },
  }
}

async function getOrCreateGastownWebhook(rest: ReturnType<typeof makeRestClient>): Promise<GastownWebhook> {
  const listed = await withDiscordRestRetry("list Gastown webhooks", () => rest.get(
    Routes.channelWebhooks(FORUM_CHANNEL_ID),
  )) as Array<{ id?: unknown; token?: unknown; name?: unknown; type?: unknown }>
  const existing = listed.find((item) => (
    item.name === GASTOWN_WEBHOOK_NAME && item.type === 1 && typeof item.id === "string" && typeof item.token === "string"
  ))
  if (existing && typeof existing.id === "string" && typeof existing.token === "string") {
    return { id: existing.id, token: existing.token }
  }

  const created = await withDiscordRestRetry("create Gastown webhook", () => rest.post(
    Routes.channelWebhooks(FORUM_CHANNEL_ID),
    { body: { name: GASTOWN_WEBHOOK_NAME } },
  )) as { id?: unknown; token?: unknown }
  if (typeof created.id !== "string" || typeof created.token !== "string" || !created.token) {
    throw new Error("Discord did not return a usable Gastown webhook token")
  }
  return { id: created.id, token: created.token }
}

function buildMirror(webhook: GastownWebhook): DelegationMirror {
  const rest = makeRestClient()
  return {
    async createThread(task) {
      if (!FORUM_CHANNEL_ID) return null
      const request = webhookThreadRequest(webhook, task)
      const response = await withDiscordRestRetry(`create Gastown thread for ${task.id}`, () => rest.post(
        request.route,
        { body: request.body, query: request.query },
      )) as { channel_id?: unknown; guild_id?: unknown }
      if (typeof response.guild_id === "string") guildId = response.guild_id
      return typeof response.channel_id === "string" ? response.channel_id : null
    },

    async postMessage(task, message) {
      if (!task.discordThreadId) return
      for (const content of chunks(mirroredPost(task, message))) {
        if (message.senderKind === "subagent") {
          const request = webhookMessageRequest(webhook, task, content)
          await withDiscordRestRetry(`mirror ${message.id}`, () => rest.post(
            request.route,
            { body: request.body, query: request.query },
          ))
        } else {
          await withDiscordRestRetry(`mirror ${message.id}`, () => rest.post(
            Routes.channelMessages(task.discordThreadId!),
            { body: { content, allowed_mentions: { parse: [] } } },
          ))
        }
      }
    },

    async updateStatus(task) {
      if (!task.discordThreadId) return
      await withDiscordRestRetry(`update Gastown thread ${task.discordThreadId}`, () => rest.patch(
        Routes.channel(task.discordThreadId!),
        { body: { name: threadName(task) } },
      ))
    },

    threadUrl(threadId) {
      return `https://discord.com/channels/${guildId ?? "@me"}/${threadId}`
    },
  }
}

export async function installGastownMirror(): Promise<void> {
  if (!FORUM_CHANNEL_ID) {
    setDelegationMirror(null)
    return
  }
  const rest = makeRestClient()
  try {
    const forum = await withDiscordRestRetry("resolve Gastown forum", () => rest.get(Routes.channel(FORUM_CHANNEL_ID))) as { guild_id?: unknown }
    if (typeof forum.guild_id === "string") guildId = forum.guild_id
    const webhook = await getOrCreateGastownWebhook(rest)
    setDelegationMirror(buildMirror(webhook))
    console.log(`[gastown] delegation webhook mirror enabled in forum ${FORUM_CHANNEL_ID}`)
  } catch (err) {
    setDelegationMirror(null)
    console.warn(`[gastown] failed to enable webhook mirror in forum ${FORUM_CHANNEL_ID}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function uninstallGastownMirror(): void {
  setDelegationMirror(null)
}

export function isGastownThread(channelId: string): boolean {
  return Boolean(getDelegatedTaskByThread(channelId))
}

/** Returns true when a Discord message belongs to a delegated-task thread. */
export async function handleGastownMessage(message: Message): Promise<boolean> {
  if (message.author.bot || message.webhookId) return Boolean(getDelegatedTaskByThread(message.channelId))
  const content = [
    message.content,
    ...message.attachments.map((attachment) => `[attachment: ${attachment.name}] ${attachment.url}`),
  ].filter(Boolean).join("\n")
  return handleDiscordDelegationMessage({
    threadId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.globalName || message.author.username,
    content,
    mentionsNiri: Boolean(message.client.user && message.mentions.users.has(message.client.user.id)),
  })
}

export const __gastownTest = { webhookThreadRequest, webhookMessageRequest, chunks, identiconUrl, webhookIdentity }
