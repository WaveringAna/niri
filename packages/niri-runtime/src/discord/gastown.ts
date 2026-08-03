import { Routes, type Message } from "discord.js"
import { makeRestClient, withDiscordRestRetry } from "./rest"
import {
  handleDiscordDelegationMessage,
  setDelegationMirror,
  type DelegationMirror,
} from "../delegation/manager"
import { getDelegatedTaskByThread, type DelegatedTask, type DelegatedTaskMessage } from "../delegation/store"

const FORUM_CHANNEL_ID = process.env.DISCORD_GASTOWN_FORUM_CHANNEL_ID?.trim() || ""
let guildId: string | null = null

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
    `**${task.profile} · ${task.id}**`,
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
  const heading = message.senderKind === "subagent"
    ? `${task.profile} · ${message.kind}`
    : `${message.senderName} → ${task.profile} · ${message.kind}`
  return `**${heading}**\n\n${message.content}`
}

function forumThreadRequest(forumChannelId: string, task: DelegatedTask) {
  return {
    route: Routes.threads(forumChannelId),
    body: {
      name: threadName(task),
      auto_archive_duration: 1440,
      message: { content: truncate(initialPost(task), 2000) },
    },
  }
}

function buildMirror(): DelegationMirror {
  const rest = makeRestClient()
  return {
    async createThread(task) {
      if (!FORUM_CHANNEL_ID) return null
      const request = forumThreadRequest(FORUM_CHANNEL_ID, task)
      const response = await withDiscordRestRetry(`create Gastown thread for ${task.id}`, () => rest.post(
        request.route,
        { body: request.body },
      )) as { id?: unknown; guild_id?: unknown }
      if (typeof response.guild_id === "string") guildId = response.guild_id
      return typeof response.id === "string" ? response.id : null
    },

    async postMessage(task, message) {
      if (!task.discordThreadId) return
      for (const content of chunks(mirroredPost(task, message))) {
        await withDiscordRestRetry(`mirror ${message.id}`, () => rest.post(
          Routes.channelMessages(task.discordThreadId!),
          { body: { content } },
        ))
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
  } catch (err) {
    console.warn(`[gastown] failed to resolve forum ${FORUM_CHANNEL_ID}: ${err instanceof Error ? err.message : String(err)}`)
  }
  setDelegationMirror(buildMirror())
  console.log(`[gastown] delegation mirror enabled in forum ${FORUM_CHANNEL_ID}`)
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

export const __gastownTest = { forumThreadRequest, chunks }
