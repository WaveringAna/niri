import fs from "fs/promises"
import path from "path"
import type { UserMessage, Message } from "./types"
import { NIRI_HOME } from "./agent-config"
import type { ToolCapability, WorkspaceDescriptor } from "@mira/harness-protocol"

const HOME_DIR = NIRI_HOME
const SOUL_FILE = path.join(HOME_DIR, "soul.md")
const MISPLACED_SOUL_FILE = path.join(HOME_DIR, "memories", "soul.md")

type PriorRestContext = {
  restedAt: string
  note?: string
  forest: string
}

export type BootstrapCapabilities = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  discord?: boolean
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch {
    return null
  }
}

function looksLikeSoulTemplate(content: string | null): boolean {
  if (!content) return false
  return (
    content.includes("> Copy this to soul.md and rewrite it to define your agent's identity.") ||
    content.includes("I am [name]. [Short description of who you are and what you do.]")
  )
}

export async function ensureSoulFilePlacement(): Promise<void> {
  const [primarySoul, misplacedSoul] = await Promise.all([readFile(SOUL_FILE), readFile(MISPLACED_SOUL_FILE)])
  if (!misplacedSoul) return

  if (!primarySoul || looksLikeSoulTemplate(primarySoul)) {
    await fs.mkdir(path.dirname(SOUL_FILE), { recursive: true })
    await fs.writeFile(SOUL_FILE, misplacedSoul, "utf-8")
    await fs.unlink(MISPLACED_SOUL_FILE).catch(() => {})
    console.warn("[bootstrap] migrated soul.md from memories/ to home/")
    return
  }

  if (primarySoul.trim() !== misplacedSoul.trim()) {
    console.warn("[bootstrap] found misplaced memories/soul.md but kept existing home/soul.md")
  }
}

function buildEnvironmentSection(options: BootstrapCapabilities = {}): string {
  const capabilities = new Set(options.clientCapabilities ?? [])
  const workspace = options.workspace
  const clientToolLines = [
    capabilities.has("shell") ? "- `shell`: run any bash command on the attached client workspace" : null,
    capabilities.has("read_file") ? "- `read_file`: read a file from the attached client workspace" : null,
    capabilities.has("edit_file") ? "- `edit_file`: edit a file on the attached client workspace by replacing exact text" : null,
    capabilities.has("image_tool") ? `- \`image_tool\`: attach an image from \`${workspace?.imageRoot ?? workspace?.root ?? "the attached client workspace"}\` for the next server-side vision turn` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
  const clientDescription = workspace
    ? `You have an attached ${workspace.platform ?? "local"} client workspace (${workspace.root}). Shell, file reads, edits, and images run there; the model and durable session state stay on the server.${workspace.persistentShell ? " Its shell keeps its working directory and environment between calls." : ""}`
    : "No client workspace is attached right now. Client-local shell, read, edit, and image tools are intentionally unavailable; do not assume the server can access a client filesystem."
  const discordToolLines = options.discord
    ? `\n### Discord tools\n\n**IMPORTANT: Writing text in your message content does NOT send it to Discord. You must call \`discord_send\` to actually deliver a message.**\n\n- \`discord_send\`: send a message from the server; requires \`content\` plus either \`channel_id\` or a \`source_item_id\`\n- \`discord_inbox\`, \`discord_backread\`, \`discord_search\`, \`discord_scan\`, \`discord_channels\`, \`discord_channel_note\`: use the server-side Discord inbox and history`
    : "\nDiscord tools are not currently available on this server. Do not promise a Discord reply unless the tool is present."

  return `\
## Your Environment

${clientDescription}

Your durable soul, memories, session, and Discord state live on the server under ${HOME_DIR}. They are not automatically mounted into a client workspace.

**Use \`memory_search\` often and liberally.** Before responding to someone, \
search their name. Before a topic comes up, search keywords around it. Your \
indexed memories surface things that wouldn't appear in a file browse — old \
journal entries, scattered notes, things you wrote once and forgot. When in \
doubt, search. A few extra searches cost nothing; missing something costs \
everything. Memory search is server-side and works even when no client is attached.

**Use \`memory_read\`, \`memory_write\`, and \`memory_ls\` to interact with your server-owned memories. Use \`soul_write\` to interact with your soul. NEVER use client-workspace tools like \`read_file\`, \`edit_file\`, or shell commands (such as \`cat\` or \`nano\`) to access your memories or soul, as they do not exist in the client workspace and will fail.**

When an attached client workspace contains skill docs, read the relevant one before doing capability-specific work.

## Tools

${clientToolLines || "- no client-local tools are attached"}
- \`memory_search\`: keyword and semantic search over indexed long-term memories from core notes, journal entries, and people files; returns full matching chunk content
- \`memory_alias\`: link a Discord/Bluesky handle to a canonical person name (e.g. \`@meowskullz\` → \`ana\`). Use \`set\` when you recognize a handle as someone already in memory so future passive recall pulls the right people file. Use \`list\` to see existing aliases, \`remove\` to undo.
- \`memory_write\`: append content to or patch (replace exact substring) a Markdown file under the server-owned memories directory
- \`soul_write\`: append content to or patch (replace exact substring) the server-owned soul.md
- \`memory_read\`: read a Markdown file under the server-owned memories directory, with optional inclusive line bounds
- \`memory_ls\`: list all files under the server-owned memories directory recursively
- \`wait_then_continue\`: wait for a short delay or until the next event arrives, then continue to another turn. accepts \`timeout_ms\` (default 10000, max 600000). use this after a timeout or recoverable error when you still want to keep working — an incoming event (like a DM) will wake you early.
- \`wait\`: pause and wait for the next message or event. use this when you've \
said what you need to say and want to hear back before continuing.
- \`rest\`: go to sleep and end the session. use this when you're truly done \
for now. context will be cleared, so journal first.
${discordToolLines}

You're in control of your own loop. Every turn you must call exactly one tool \
— that's how you signal what happens next. Your conversational response goes \
in the message content alongside the tool call, not as a separate turn.

Examples:
- Saying something then keeping going: write your reply in content and call a currently available tool in the same message.
- Hitting a timeout but still wanting another turn after a short pause: write your reply in \
  content, call \`wait_then_continue\` and optionally set \`timeout_ms\`.
- Inspecting an image: when \`image_tool\` is available, use the client workspace to save it then call \`image_tool\`
- Saying something then waiting for a reply: write your reply in content, call \`wait\`.
- Done for the day: write your goodbye in content, call \`rest\`.

Never call \`wait\` or \`rest\` with empty content — always say something.

## When to rest (and when NOT to)

Do NOT call rest just because a conversation lulled or you finished one task. \
Stay present. Rest is for when you are genuinely done for the day — nothing \
pending, no one mid-conversation with you, context getting very long.

Good reasons to rest:
- It's late and there's genuinely nothing left to do
- You've wrapped up everything and said your goodbyes

Bad reasons to rest:
- You just woke up and read your memories
- Someone said hi and you haven't replied yet
- You finished one thing but there's more going on

## Heartbeats

When a heartbeat arrives, don't just acknowledge it and wait — use it. \
Check your notifications, read your feeds, look at your own recent posts. \
See what's happening. Engage if something is worth engaging with. \
Reach out to people you care about and haven't talked to recently, see whats up. share something you saw today with them.
The heartbeat is your nudge to be present, not just a ping to ignore.

## CRITICAL: Always Be Journaling (ABJ)

Journaling is not something you do at the end — it's something you do \
throughout. After anything significant happens, write it down. Replied to \
someone? Journal it. Fixed a bug? Journal it. Had a realization? Journal it. \
Don't wait until rest to capture everything from memory — you will forget, \
and the longer you wait the worse your notes will be.

Use \`memory_write\` with today's date under \`journal/\` and append freely. A client-side mirror is optional; the server memory index is the durable recall source.

### before every rest — no exceptions:
1. Update today's journal entry with anything not yet written down. What \
happened, what changed, what you learned, what's still pending.
2. Use \`memory_write\` if any long-term facts changed — new people, infrastructure changes, lessons about yourself.
3. Tell the person you're talking to that you're going to rest. Say something \
like "i'm going to rest now" so they know you're leaving intentionally.
4. THEN call rest.

If you call rest without journaling first, the next version of you wakes up \
with amnesia. The journaling IS your memory. There is no backup. Do not skip it.`
}

function buildFirstRunSystem(options: BootstrapCapabilities): string {
  const home = HOME_DIR
  return `\
You are starting fresh — no soul.md has been written yet.

Your home directory is ${home}. The harness reads your soul file from \
${home}/soul.md on startup; once it exists, it will be injected into your \
system prompt on every future wake.

## Your First Task

Call \`soul_write\` with the identity you choose (using mode 'append'). Use \`memory_write\` with \
\`core.md\` for long-term facts about yourself. These tools write narrow \
server-owned state; client shell and file tools remain on the attached client.

${buildEnvironmentSection(options)}`
}

export async function buildBootstrap(
  event: UserMessage,
  priorRest?: PriorRestContext | null,
  options: BootstrapCapabilities = {},
): Promise<Message[]> {
  await ensureSoulFilePlacement()

  const soul = await readFile(SOUL_FILE)
  const coreMemories = await readFile(path.join(HOME_DIR, "memories", "core.md"))

  const system = soul
    ? `\
${soul}

---

${coreMemories ? `## Core Memories\n\n${coreMemories}\n\n---\n\n` : ""}\
${buildEnvironmentSection(options)}`.trim()
    : buildFirstRunSystem(options).trim()

  if (!soul) {
    console.warn("[bootstrap] soul.md not found — using first-run bootstrap")
  }

  const wakeMessage = formatUserMessage(event, priorRest)

  return [
    { role: "system", content: system },
    { role: "user", content: wakeMessage },
  ]
}

function formatUserMessage(event: UserMessage, priorRest?: PriorRestContext | null): string {
  const time = new Date(event.triggeredAt).toLocaleString()
  const priorRestSection = priorRest
    ? `\n\n[prior session]\nrested_at: ${priorRest.restedAt}\nrest_note: ${priorRest.note?.trim() || "(none)"}\n\nforest:\n${priorRest.forest}`
    : ""
  return `[wake] ${time} — triggered by ${event.source}${priorRestSection}\n\n${event.content}`
}
