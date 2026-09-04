import type {
  ConversationCompaction,
  Message,
  SummarizerModel,
  SummaryCircuit,
  SummaryPromptContext,
  SummaryPrompts,
  SummarySegmentInput,
} from "./types.js"

/**
 * Transcript summarization: chunk a long transcript, reject meta-replies,
 * require a minimum reduction, and report provider quality to a circuit
 * breaker. The voice is the caller's, via {@link SummaryPrompts}.
 */

function looksLikeMetaReply(text: string): boolean {
  const head = text.slice(0, 400)
  return SUMMARY_META_REPLY_PATTERNS.some((re) => re.test(head))
}

/** Local error formatter; keeps this package independent of `@mira/agent-llm`. */
function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

const CONTEXT_SUMMARY_HEADER = "[context summary v1]"
const CONTEXT_SUMMARY_SEGMENTS_MARKER = "[segments]"
const SUMMARY_LINE_DEFAULT_EMPTY = "(no text)"
const TOOL_ACK_RESULT = "(ok)"
const WAIT_TOOL_RESULT = "Waiting for next event."

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function messageRole(message: Message): string {
  const record = asRecord(message)
  return typeof record?.role === "string" ? record.role : ""
}

function messageStringContent(message: Message): string {
  const record = asRecord(message)
  const content = record?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const chunks: string[] = []
  for (const part of content) {
    const partRecord = asRecord(part)
    if (!partRecord) continue
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      chunks.push(partRecord.text)
      continue
    }
    if (partRecord.type === "image_url") chunks.push("[image]")
  }

  return chunks.join(" ")
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateSummaryText(value: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function assistantToolCalls(message: Message): { id: string; name: string; args: Record<string, unknown> }[] {
  const record = asRecord(message)
  const calls = record?.tool_calls
  if (!Array.isArray(calls)) return []

  const out: { id: string; name: string; args: Record<string, unknown> }[] = []
  for (const call of calls) {
    const callRecord = asRecord(call)
    const fn = asRecord(callRecord?.function)
    const name = typeof fn?.name === "string" ? fn.name.trim() : ""
    if (!name) continue
    let args: Record<string, unknown> = {}
    const rawArgs = fn?.arguments
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
      } catch {
        // ignore malformed arg json
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>
    }
    out.push({ id: typeof callRecord?.id === "string" ? callRecord.id : "", name, args })
  }
  return out
}

function describeToolCall(call: { name: string; args: Record<string, unknown> }): string | null {
  const { name, args } = call
  if (name === "wait") return null
  if (name === "discord_send") {
    const content = typeof args.content === "string" ? args.content : ""
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    const channelTag = channelId ? `ch/${channelId.slice(-6)}` : "ch?"
    if (!content) return `discord_send -> ${channelTag}`
    return `discord_send -> ${channelTag}: ${normalizeSummaryText(content)}`
  }
  if (name === "shell") {
    const cmd = typeof args.command === "string" ? args.command : ""
    return cmd ? `shell: ${normalizeSummaryText(cmd)}` : "shell"
  }
  if (name === "image_tool") {
    const p = typeof args.path === "string" ? args.path : ""
    return p ? `image_tool ${p}` : "image_tool"
  }
  if (name === "discord_backread" || name === "discord_inbox" || name === "discord_channels") {
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    return channelId ? `${name} ch/${channelId.slice(-6)}` : name
  }
  // Fallback: compact arg snippet
  const argKeys = Object.keys(args)
  if (argKeys.length === 0) return name
  const snippet = argKeys
    .slice(0, 3)
    .map((k) => `${k}=${truncateSummaryText(normalizeSummaryText(String(args[k] ?? "")), 40)}`)
    .join(" ")
  return `${name} ${snippet}`.trim()
}

const DISCORD_BATCH_SKIP_PREFIXES = [
  "[discord batch]",
  "new_messages=",
  "auto_seen_timeout=",
  "channel_flag_repairs=",
  "channel messages are context",
  "you can reply if useful",
  "pending preview:",
]

function compactDiscordBatch(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let inPendingPreview = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === "pending preview:") {
      inPendingPreview = true
      continue
    }
    if (inPendingPreview) {
      // pending preview block continues until we hit a non-bullet line
      if (line.startsWith("- ")) continue
      inPendingPreview = false
    }
    if (DISCORD_BATCH_SKIP_PREFIXES.some((p) => line.startsWith(p))) continue
    kept.push(line)
  }
  return kept.join(" ")
}

function compactToolResult(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (trimmed === WAIT_TOOL_RESULT) return null
  // Compact discord_send ok JSON to a short ack
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>
        if (rec.ok === true) {
          const sentId = typeof rec.sent_message_id === "string" ? rec.sent_message_id : null
          if (sentId) return `${TOOL_ACK_RESULT} sent ${sentId.slice(-6)}`
          const itemId = typeof rec.item_id === "string" ? rec.item_id : null
          if (itemId) return `${TOOL_ACK_RESULT} ${itemId.slice(-6)}`
          return TOOL_ACK_RESULT
        }
        if (rec.ok === false || typeof rec.error === "string") {
          const err = typeof rec.error === "string" ? rec.error : "error"
          return `error: ${err}`
        }
      }
    } catch {
      // fall through to default handling
    }
  }
  return normalizeSummaryText(trimmed)
}

function splitSummaryTranscript(lines: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let current = ""

  const flush = () => {
    if (!current) return
    chunks.push(current)
    current = ""
  }

  for (const line of lines) {
    let remaining = line
    while (remaining.length > 0) {
      const separatorChars = current ? 1 : 0
      const available = maxChars - current.length - separatorChars
      if (available <= 0) {
        flush()
        continue
      }
      if (remaining.length <= available) {
        current += `${current ? "\n" : ""}${remaining}`
        remaining = ""
        continue
      }

      // A single unusually large message must not make the later transcript
      // unreachable. Split it across chronological chunks rather than slicing
      // the complete transcript at the global character limit.
      current += `${current ? "\n" : ""}${remaining.slice(0, available)}`
      remaining = remaining.slice(available)
      flush()
    }
  }
  flush()
  return chunks
}

function messageToolCallId(message: Message): string {
  const record = asRecord(message)
  return typeof record?.tool_call_id === "string" ? record.tool_call_id : ""
}

function summarizeMessageLine(message: Message, toolName = ""): string | null {
  const role = messageRole(message)
  const rawContent = messageStringContent(message)

  if (role === "assistant") {
    const calls = assistantToolCalls(message).filter((call) => call.name.startsWith("discord_"))
    const callDescs = calls.map(describeToolCall).filter((d): d is string => d !== null)
    const text = normalizeSummaryText(rawContent)
    // Drop pure wait-only assistant turns (no text, only filtered out wait calls)
    if (!text && callDescs.length === 0) return null
    const parts: string[] = []
    if (text) parts.push(text)
    if (callDescs.length > 0) parts.push(`[${callDescs.join(" | ")}]`)
    return `- assistant: ${parts.join(" ")}`
  }

  if (role === "tool") {
    if (!toolName.startsWith("discord_")) return null
    const compact = compactToolResult(rawContent)
    if (compact === null) return null
    return `- tool: ${compact}`
  }

  if (role === "user") {
    const stripped = rawContent.startsWith("[incoming — discord]")
      ? compactDiscordBatch(rawContent)
      : normalizeSummaryText(rawContent)
    const safe = stripped || SUMMARY_LINE_DEFAULT_EMPTY
    return `- user: ${safe}`
  }

  if (role === "system") {
    const text = normalizeSummaryText(rawContent) || SUMMARY_LINE_DEFAULT_EMPTY
    return `- system: ${text}`
  }

  const text = normalizeSummaryText(rawContent) || SUMMARY_LINE_DEFAULT_EMPTY
  return `- ${role || "message"}: ${text}`
}

function countLeadingSystemMessages(messages: Message[]): number {
  let count = 0
  while (count < messages.length && messageRole(messages[count]!) === "system") count++
  return count
}

export function findSummaryMessageIndex(messages: Message[]): number {
  return messages.findIndex((message) => {
    const content = messageStringContent(message)
    return content.startsWith(CONTEXT_SUMMARY_HEADER)
  })
}

export function findSummaryMessageIndexes(messages: Message[]): number[] {
  return messages.flatMap((message, index) =>
    messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER) ? [index] : [])
}

/**
 * Very rough tokenizer-agnostic estimate for prompt size guardrails.
 *
 * Includes both messages and tool schema to mirror completion request payload.
 */
export function estimatePromptTokens(messages: Message[], tools: unknown = []): number {
  // Mirrors the completion payload: the tool schema is a real and often large
  // part of prompt size, so a messages-only estimate under-reports badly.
  const jsonChars = JSON.stringify({ messages, tools }).length
  return Math.ceil(jsonChars / 4)
}

/**
 * Picks the largest tail of recent messages that fits the given char budget,
 * subject to min/max message counts. Backs up over orphaned tool responses
 * so the tail always starts at a self-contained boundary.
 */
function chooseTailStart(
  messages: Message[],
  floor: number,
  minKeep: number,
  maxKeep: number,
  charBudget: number,
): number {
  let chars = 0
  let kept = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    const c = messageStringContent(messages[i]!).length
    if (kept >= minKeep && (chars + c > charBudget || kept >= maxKeep)) break
    chars += c
    start = i
    kept += 1
  }
  while (start > floor && messageRole(messages[start]!) === "tool") start--
  return start
}

/** Returns the raw messages a normal compaction would fold into its next summary node. */
export function countConversationCompactionCandidates(
  messages: Message[],
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
  } = {},
): number {
  const recentMinKeep = options.recentMinKeep === 0 ? 0 : Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = options.recentMaxKeep === 0 ? 0 : Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const leadingSystems = countLeadingSystemMessages(messages)
  const rawMessages = messages
    .slice(leadingSystems)
    .filter((message) => !messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const tailStart = chooseTailStart(rawMessages, 0, recentMinKeep, recentMaxKeep, tailCharBudget)
  return Math.max(0, tailStart)
}

const SUMMARY_MIN_TRANSCRIPT_CHARS = 1_200
const SUMMARY_MIN_REDUCTION = 0.1
const SUMMARY_META_REPLY_PATTERNS = [
  /\bcould you (?:share|provide|paste|send)\b/i,
  /\bplease (?:share|provide|paste|send)\b/i,
  /\bappears to be (?:cut off|truncated|incomplete|empty)\b/i,
  /\bI don'?t see (?:any|the) (?:content|message|transcript)\b/i,
  /\bno (?:content|transcript|messages?) (?:was|were) provided\b/i,
]





export async function summarizeConversationViaLLMWithProvenance(
  agentName: string,
  messages: Message[],
  model: SummarizerModel,
  circuit: SummaryCircuit,
  prompts: SummaryPrompts,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null | undefined
    directRecollection?: string | null | undefined
  } = {},
): Promise<ConversationCompaction | null> {
  const recentMinKeep = Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const maxTranscriptChars = Math.max(2_000, options.maxTranscriptChars ?? 40_000)

  const leadingSystems = countLeadingSystemMessages(messages)
  const head = messages.slice(0, leadingSystems)
  const afterHead = messages.slice(leadingSystems)
  const summaries = afterHead.filter((message) => messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const rawMessages = afterHead.filter((message) => !messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
  const tailStart = chooseTailStart(rawMessages, 0, recentMinKeep, recentMaxKeep, tailCharBudget)
  if (tailStart <= 0) return null

  const middle = rawMessages.slice(0, tailStart)
  const tail = rawMessages.slice(tailStart)
  const replacedChars = middle.reduce((acc, message) => acc + messageStringContent(message).length, 0)
  const directRecollectionMessages: Message[] = options.directRecollection?.trim()
    ? [
        { role: "user", content: prompts.recollectionPrompt },
        { role: "assistant", content: options.directRecollection },
      ]
    : []

  const toolNames = new Map<string, string>()
  const transcriptLines = middle.flatMap((message) => {
    for (const call of assistantToolCalls(message)) {
      if (call.id) toolNames.set(call.id, call.name)
    }
    const line = summarizeMessageLine(message, toolNames.get(messageToolCallId(message)) ?? "")
    return line === null ? [] : [line]
  })
  if (transcriptLines.length < 3 && replacedChars < SUMMARY_MIN_TRANSCRIPT_CHARS) return null
  const summaryLines = transcriptLines.length > 0
    ? transcriptLines
    : ["- a large non-social tool result was omitted from the memory transcript; preserve that tool work occurred without inventing its contents"]
  const transcriptChunks = splitSummaryTranscript(summaryLines, maxTranscriptChars)
  const transcriptChars = transcriptChunks.reduce((total, chunk) => total + chunk.length, 0)
  if (transcriptChars < SUMMARY_MIN_TRANSCRIPT_CHARS && replacedChars < SUMMARY_MIN_TRANSCRIPT_CHARS) return null

  if (circuit.isOpen()) return null

  const promptContext: SummaryPromptContext = {
    agentName,
    grounding: options.agentContext ?? null,
    directRecollection: options.directRecollection ?? null,
  }
  const systemContent = prompts.segment(promptContext)
  try {
    const completeSummary = (system: string, user: string): Promise<string> =>
      model.completeText(system, user)

    let summaryText: string
    if (transcriptChunks.length === 1) {
      summaryText = await completeSummary(systemContent, transcriptChunks[0]!)
    } else {
      console.log(
        `[context agent=${agentName}] summarizing complete transcript in ${transcriptChunks.length} chronological chunks (${transcriptChars} chars)`,
      )
      const partials: string[] = []
      for (let index = 0; index < transcriptChunks.length; index++) {
        const partial = await completeSummary(
          `${systemContent}${prompts.chunkSuffix(index + 1, transcriptChunks.length)}`,
          transcriptChunks[index]!,
        )
        if (!partial) {
          circuit.recordUnusable(`empty chronological part ${index + 1}`)
          return null
        }
        partials.push(partial)
      }
      summaryText = await completeSummary(
        prompts.consolidate(promptContext),
        partials.map((partial, index) => `## chronological part ${index + 1}\n${partial}`).join("\n\n"),
      )
    }
    if (!summaryText) {
      circuit.recordUnusable("empty summary response")
      return null
    }
    if (summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      console.warn(`[context agent=${agentName}] llm summarization rejected (looks like meta-reply): ${summaryText.slice(0, 200)}`)
      circuit.recordUnusable("summary response was too short or a meta-reply")
      return null
    }

    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      console.warn(`[context agent=${agentName}] llm summarization rejected: insufficient reduction (${summaryText.length} vs ${replacedChars} chars)`)
      circuit.recordUnusable("summary response did not reduce the transcript")
      return null
    }

    const summaryContent =
      `${prompts.summaryHeader}\n${prompts.summaryNote}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
      `[llm-summary ${new Date().toISOString()}]\n${summaryText}`
    circuit.recordSuccess()

    return {
      messages: [
        ...head,
        ...summaries,
        { role: "user", content: summaryContent } as Message,
        ...tail,
      ],
      summaryText,
      summaryContent,
      compactedMessages: [...middle, ...directRecollectionMessages],
    }
  } catch (err) {
    circuit.recordFailure(err)
    console.warn(`[context agent=${agentName}] llm summarization failed: ${errorSummary(err)}`)
    return null
  }
}

/** Consolidates one ordered same-depth segment batch into a higher-level summary. */
export async function summarizeContextSummaryBatchViaLLM(
  agentName: string,
  segments: SummarySegmentInput[],
  model: SummarizerModel,
  circuit: SummaryCircuit,
  prompts: SummaryPrompts,
  options: {
    agentContext?: string | null | undefined
    directRecollection?: string | null | undefined
  } = {},
): Promise<{ summaryText: string; summaryContent: string } | null> {
  if (segments.length < 2) return null
  const depth = segments[0]!.depth
  if (!segments.every((segment) => segment.depth === depth)) return null
  if (circuit.isOpen()) return null
  const transcript = segments.map((segment, index) =>
    `## segment ${index + 1}: ${segment.id} (depth ${segment.depth})\n${segment.content}`
  ).join("\n\n")
  const promptContext: SummaryPromptContext = {
    agentName,
    grounding: options.agentContext ?? null,
    directRecollection: options.directRecollection ?? null,
  }
  const systemContent = prompts.merge(promptContext)
  try {
    const summaryText = await model.completeText(systemContent, transcript)
    if (!summaryText || summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      circuit.recordUnusable("segment summary response was empty, too short, or a meta-reply")
      return null
    }
    const replacedChars = segments.reduce((total, segment) => total + segment.content.length, 0)
    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      circuit.recordUnusable("segment summary response did not reduce its inputs")
      return null
    }
    circuit.recordSuccess()
    return {
      summaryText,
      summaryContent:
        `${prompts.summaryHeader}\n${prompts.summaryNote}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
        `[llm-summary ${new Date().toISOString()}]\n${summaryText}`,
    }
  } catch (err) {
    circuit.recordFailure(err)
    console.warn(`[context agent=${agentName}] lcm segment merge failed: ${errorSummary(err)}`)
    return null
  }
}

/** Backward-compatible summary helper for callers that do not need provenance. */
export async function summarizeConversationViaLLM(
  agentName: string,
  messages: Message[],
  model: SummarizerModel,
  circuit: SummaryCircuit,
  prompts: SummaryPrompts,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null | undefined
    directRecollection?: string | null | undefined
  } = {},
): Promise<Message[] | null> {
  const compacted = await summarizeConversationViaLLMWithProvenance(agentName, messages, model, circuit, prompts, options)
  return compacted?.messages ?? null
}

export type SummarizerDeps = {
  agentName: string
  model: SummarizerModel
  circuit: SummaryCircuit
  prompts: SummaryPrompts
}
