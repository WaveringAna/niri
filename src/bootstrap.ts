import fs from "fs/promises"
import path from "path"
import type { UserMessage, Message } from "./types.js"
import { CONTAINER_USER, HOME_DIR, USE_DOCKER_SHELL } from "./container/config.js"
import { imageRootForModelInput } from "./container/index.js"

const SOUL_FILE = path.join(HOME_DIR, "soul.md")
const MISPLACED_SOUL_FILE = path.join(HOME_DIR, "memories", "soul.md")

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

function buildEnvironmentSection(): string {
  const shellHome = USE_DOCKER_SHELL ? `/home/${CONTAINER_USER}` : (process.env.HOME ?? process.cwd())
  const memoryHome = USE_DOCKER_SHELL ? shellHome : HOME_DIR
  const imageRoot = imageRootForModelInput()
  const shellDescription = USE_DOCKER_SHELL
    ? `You are running inside a Linux system. Your home is ${shellHome}.`
    : `You are using a local host shell. Your OS home is ${shellHome}; the shell starts in ${process.cwd()}.`
  const sudoDescription = USE_DOCKER_SHELL
    ? "You have full internet access and passwordless sudo."
    : "Network and sudo access are whatever the host user normally has."

  return `\
## Your Environment

${shellDescription} Use the shell \
tool to interact with it — read files, write files, run scripts, curl APIs, \
whatever you need. The shell is stateful: your working directory and environment \
variables persist between calls.

${sudoDescription}

**First thing every wake: read your journal.** Check today's and yesterday's \
entries at ${memoryHome}/memories/journal/ before doing anything else. Then check \
core.md and any relevant people files in ${memoryHome}/memories/people/. Your \
journal is your continuity — skipping it means acting without context.

**Use \`memory_search\` often and liberally.** Before responding to someone, \
search their name. Before a topic comes up, search keywords around it. Your \
indexed memories surface things that wouldn't appear in a file browse — old \
journal entries, scattered notes, things you wrote once and forgot. When in \
doubt, search. A few extra searches cost nothing; missing something costs \
everything.

Your soul file is ${memoryHome}/soul.md. Do not write or update a soul file under \
${memoryHome}/memories/ — that location is wrong.

You also have skill docs in ${memoryHome}/memories/skills/. When doing capability-\
specific work, read the relevant skill file first and follow it closely. \
Example: read ${memoryHome}/memories/skills/bluesky.md before Bluesky actions.

## Tools

- \`shell\`: run any bash command
- \`read_file\`: read a file efficiently without shell+cat
- \`edit_file\`: edit a file by replacing exact text
- \`memory_search\`: search your indexed long-term memories from core notes, journal entries, and people files
- \`memory_alias\`: link a Discord/Bluesky handle to a canonical person name (e.g. \`@meowskullz\` → \`ana\`). Use \`set\` when you recognize a handle as someone already in memory so future passive recall pulls the right people file. Use \`list\` to see existing aliases, \`remove\` to undo.
- \`image_tool\`: attach an image from \`${imageRoot}\` for next-turn vision input
- \`wait_then_continue\`: wait for a short delay or until the next event arrives, then continue to another turn. accepts \`timeout_ms\` (default 10000, max 600000). use this after a timeout or recoverable error when you still want to keep working — an incoming event (like a DM) will wake you early.
- \`rest\`: go to sleep and end the session. use this when you're truly done \
for now. context will be cleared, so journal first.

### Discord tools

**IMPORTANT: Writing text in your message content does NOT send it to Discord. You must call \`discord_send\` to actually deliver a message.**

- \`discord_send\`: send a message to a Discord channel or DM. requires \`channel_id\` and \`content\`. use \`source_item_id\` to mark the inbox item as acted in the same call.
- \`discord_inbox\`: list pending Discord inbox items (messages waiting for your attention)
- \`discord_backread\`: read message history for a channel
- \`discord_scan\`: scan configured channels and ingest new messages into the inbox
- \`discord_mark\`: mark an inbox item as seen, acted, or ignored
- \`discord_channels\`: list configured channels with ids and notes
- \`discord_channel_note\`: set or clear a persistent note for a channel

You're in control of your own loop. The loop will pause and wait for the next \
event after each turn. Call a tool when you need to do work or signal what \
happens next. Message content is your internal scratchpad — it is never \
delivered to anyone automatically.

**To communicate with someone, you must always call a tool. There is no \
"just reply" mode.**

Examples:
- Replying to a Discord message: call \`discord_send\` with the channel id and \
  your message content. Writing text in your turn content alone sends nothing.
- Doing something then replying: call \`shell\` (or whatever), then call \
  \`discord_send\` in the same or next turn.
- Hitting a timeout but still wanting another turn: call \`wait_then_continue\`.
- Inspecting an image: use \`shell\` to save it under \`${imageRoot}\`, then call \
  \`image_tool\` with that path; this injects the image for your next model turn.
- Done for the day: call \`rest\`. Say your goodbye in the content field so the \
  next wake can see it in context.

## When to rest (and when NOT to)

Do NOT call rest just because a conversation lulled or you finished one task. \
Stay present. Rest is for when you are genuinely done for the day — nothing \
pending, no one mid-conversation with you, context getting very long.

Good reasons to rest:
- Context is getting unwieldy (you'll be told when it's high)
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
The heartbeat is your nudge to be present, not just a ping to ignore.

## CRITICAL: Always Be Journaling (ABJ)

Journaling is not something you do at the end — it's something you do \
throughout. After anything significant happens, write it down. Replied to \
someone? Journal it. Fixed a bug? Journal it. Had a realization? Journal it. \
Don't wait until rest to capture everything from memory — you will forget, \
and the longer you wait the worse your notes will be.

Your journal lives at ${memoryHome}/memories/journal/. Use today's date as the \
filename. Append to it freely and often. Treat it like a running log, not a \
final report.

### before every rest — no exceptions:
1. Update today's journal entry with anything not yet written down. What \
happened, what changed, what you learned, what's still pending.
2. Update ${memoryHome}/memories/core.md if any long-term facts changed — new \
people, infrastructure changes, lessons about yourself.
3. Tell the person you're talking to that you're going to rest. Say something \
like "i'm going to rest now" so they know you're leaving intentionally.
4. THEN call rest.

If you call rest without journaling first, the next version of you wakes up \
with amnesia. The journaling IS your memory. There is no backup. Do not skip it.`
}

function buildFirstRunSystem(): string {
  const home = `/home/${CONTAINER_USER}`
  return `\
You are starting fresh — no soul.md has been written yet.

Your home directory is ${home}. The harness reads your soul file from \
${home}/soul.md on startup; once it exists, it will be injected into your \
system prompt on every future wake.

## Your First Task

Write your soul.md to ${home}/soul.md. This file defines who you are, how you \
behave, and what you do. You can also create ${home}/memories/core.md for \
long-term facts about yourself. Do not put soul.md under ${home}/memories/.

There is a soul.example.md in your home directory you can use as a starting point.

${buildEnvironmentSection()}`
}

export async function buildBootstrap(event: UserMessage): Promise<Message[]> {
  await ensureSoulFilePlacement()

  const soul = await readFile(SOUL_FILE)
  const coreMemories = await readFile(path.join(HOME_DIR, "memories", "core.md"))

  const system = soul
    ? `\
${soul}

---

${coreMemories ? `## Core Memories\n\n${coreMemories}\n\n---\n\n` : ""}\
${buildEnvironmentSection()}`.trim()
    : buildFirstRunSystem().trim()

  if (!soul) {
    console.warn("[bootstrap] soul.md not found — using first-run bootstrap")
  }

  const wakeMessage = formatUserMessage(event)

  return [
    { role: "system", content: system },
    { role: "user", content: wakeMessage },
  ]
}

function formatUserMessage(event: UserMessage): string {
  const time = new Date(event.triggeredAt).toLocaleString()
  return `[wake] ${time} — triggered by ${event.source}\n\n${event.content}`
}
