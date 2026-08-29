import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import go from "highlight.js/lib/languages/go"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("css", css)
hljs.registerLanguage("go", go)
hljs.registerLanguage("json", json)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("python", python)
hljs.registerLanguage("rust", rust)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("typescript", typescript)

type Panel = {
  id: string
  name: string
  baseUrl: string
}

type Agent = {
  id: string
  name: string
  baseUrl: string
  status: string
  lastSeenAt?: string
  lastSeq: number
}

type WorkerStatus = {
  agentId?: string
  running?: boolean
  idle?: boolean
  tokenCount?: number
  contextSize?: number
  processStartedAt?: string
  uptimeMs?: number
  error?: string
  client?: {
    connected?: boolean
    clientId?: string
    capabilities?: string[]
    workspace?: { root?: string }
  }
}

type Compaction = {
  agentId: string
  seq: number
  eventId: string
  metricId?: number
  timestamp: string
  method?: string
  before?: number
  after?: number
  savedTokens?: number
  summary?: string
}

type ContextSourceStats = {
  messageCount: number
  estimatedTokens: number
  earliestAt: string | null
  latestAt: string | null
}

type ContextDagSummary = {
  content: string
  method: string
  createdAt: string
  parentIds: string[]
  parentSegments: Array<{ id: string; content: string; method: string; createdAt: string; depth: number }>
  childIds: string[]
  depth: number
  provenanceNodeCount: number
  directSources: ContextSourceStats
  expandedSources: ContextSourceStats
}

type ContextDagNode = {
  id: string
  type: "summary"
  summary: ContextDagSummary
  expansion: { totalMessages: number; estimatedPages: number }
}

type ContextDagFrontier = {
  id: string
  depth: number
  summary: ContextDagSummary | null
}

type WorkerEvent = {
  id: string
  agentId: string
  seq: number
  type: string
  createdAt: string
  payload: unknown
}

type CacheSample = {
  key: string
  at: string
  promptTokens: number
  cachedPromptTokens: number
  cacheWriteTokens?: number
}

type CacheStats = {
  samples: CacheSample[]
  latestRate: number
  recentRate: number
  recentPromptTokens: number
  recentCachedTokens: number
  recentCacheWriteTokens: number
}

type Overview = {
  agent: Agent
  status: WorkerStatus
  compactions: Compaction[]
}

type DiscordChannel = {
  channel_id: string
  guild_id: string | null
  guild_name: string | null
  channel_name: string | null
  channel_type: number | null
  is_dm: number
  configured: number
  topic: string | null
  last_seen_at: string
}

type DiscordMessage = {
  message_id: string
  channel_id: string
  author_username: string | null
  content: string
  created_at: string
  is_from_bot: number
}

type ChatLine = {
  key: string
  seq: number
  at: string
  kind: "agent" | "user" | "tool" | "note" | "context" | "error" | "thinking"
  label: string
  text: string
  detail?: string
  toolArgs?: Record<string, unknown>
}

const PANEL_COOKIE = "niri_control_panels"
const NOTES_WIDTH_STORAGE_KEY = "niri_notes_width"
const NOTES_WIDTH_MIN = 220
const NOTES_WIDTH_MAX = 1_000

function clampNotesWidth(value: number): number {
  return Math.min(NOTES_WIDTH_MAX, Math.max(NOTES_WIDTH_MIN, value))
}

function readNotesWidth(): number {
  const raw = window.localStorage.getItem(NOTES_WIDTH_STORAGE_KEY)
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) ? clampNotesWidth(value) : 286
}

function cookieValue(name: string): string | null {
  const prefix = `${name}=`
  const item = document.cookie.split("; ").find((part) => part.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : null
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith("//")) return `${window.location.protocol}${trimmed}`
  return `http://${trimmed}`
}

function urlFor(panel: Panel, path: string): string {
  const base = panel.baseUrl || window.location.origin
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString()
}

function readPanels(): Panel[] {
  const raw = cookieValue(PANEL_COOKIE)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Panel[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .filter((panel) => typeof panel.id === "string" && typeof panel.baseUrl === "string")
          .map((panel) => ({
            id: panel.id,
            name: panel.name || panel.baseUrl || "this control",
            baseUrl: cleanBaseUrl(panel.baseUrl),
          }))
      }
    } catch {}
  }

  return [
    {
      id: "same-origin",
      name: "this control",
      baseUrl: "",
    },
  ]
}

function savePanels(panels: Panel[]): void {
  writeCookie(PANEL_COOKIE, JSON.stringify(panels))
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : `${res.status} ${res.statusText}`
    throw new Error(message)
  }
  return data as T
}

async function consumeWorkerStream(url: string, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<void> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(res.ok ? "stream body missing" : `${res.status} ${res.statusText}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
    const blocks = buffer.split("\n\n")
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const payload = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!payload) continue
      try {
        onEvent(JSON.parse(payload) as WorkerEvent)
      } catch {}
    }
  }
}

function eventPayloadObject(event: WorkerEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {}
}

function formatTime(value: string | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "just started"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${Math.max(1, totalSeconds)}s`
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0"
  return new Intl.NumberFormat().format(value)
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${Math.round(value * 100)}%`
}

function cacheStatsFromEvents(events: WorkerEvent[]): CacheStats | null {
  const samples = events.flatMap((event): CacheSample[] => {
    if (event.type !== "stream.event" || !event.payload || typeof event.payload !== "object") return []
    const payload = event.payload as Record<string, unknown>
    if (payload.type !== "usage") return []
    const promptTokens = typeof payload.promptTokens === "number" ? payload.promptTokens : 0
    const cachedPromptTokens = typeof payload.cachedPromptTokens === "number" ? payload.cachedPromptTokens : NaN
    if (!Number.isFinite(promptTokens) || promptTokens <= 0 || !Number.isFinite(cachedPromptTokens)) return []
    return [{
      key: event.id,
      at: event.createdAt,
      promptTokens,
      cachedPromptTokens: Math.max(0, Math.min(promptTokens, cachedPromptTokens)),
      ...(typeof payload.cacheWriteTokens === "number" && Number.isFinite(payload.cacheWriteTokens)
        ? { cacheWriteTokens: Math.max(0, payload.cacheWriteTokens) }
        : {}),
    }]
  }).slice(-20)
  const latest = samples.at(-1)
  if (!latest) return null
  const recentPromptTokens = samples.reduce((total, sample) => total + sample.promptTokens, 0)
  const recentCachedTokens = samples.reduce((total, sample) => total + sample.cachedPromptTokens, 0)
  const recentCacheWriteTokens = samples.reduce((total, sample) => total + (sample.cacheWriteTokens ?? 0), 0)
  return {
    samples,
    latestRate: latest.cachedPromptTokens / latest.promptTokens,
    recentRate: recentPromptTokens > 0 ? recentCachedTokens / recentPromptTokens : 0,
    recentPromptTokens,
    recentCachedTokens,
    recentCacheWriteTokens,
  }
}

function discordChannelLabel(channel: DiscordChannel): string {
  if (channel.is_dm) return channel.channel_name || channel.guild_name || "direct message"
  return channel.channel_name ? `#${channel.channel_name}` : channel.channel_id
}

function jsonToolLabel(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const first = value[0]
    if (first && typeof first === "object" && "item_id" in first) return `discord_inbox ${value.length} item${value.length === 1 ? "" : "s"}`
    if (first && typeof first === "object" && "message_id" in first) return `discord_messages ${value.length}`
    return `json array ${value.length}`
  }

  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if ("sent_message_id" in record) return `discord_send ${record.ok === true ? "ok" : "result"}`
  if ("item_id" in record && "status" in record) return `discord_mark ${String(record.status)}`
  if ("scanned_channels" in record) return `discord_scan ${formatNumber(Number(record.fetched_messages))} messages`
  if ("ok" in record) return record.ok === true ? "ok" : "tool result"
  return null
}

function toolLabel(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  const first = lines[0]
  if (!first) return "tool"
  if (first.startsWith("discord_send ok")) {
    const sent = lines.find((line) => line.startsWith("sent: "))?.slice(6).trim()
    if (sent) {
      const label = `discord_send ok: ${sent}`
      return label.length <= 120 ? label : `${label.slice(0, 117)}...`
    }
  }
  if (first.trim().startsWith("{") || first.trim().startsWith("[")) {
    try {
      return jsonToolLabel(JSON.parse(text)) ?? "tool result"
    } catch {
      return "tool result"
    }
  }
  if (first.length <= 82) return first
  return `${first.slice(0, 79)}...`
}

function truncateInline(text: string, maxChars: number): string {
  const single = text.replace(/\s+/gu, " ").trim()
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single
}

function codeSummary(code: string): string {
  const lineCount = code.split("\n").length
  const first = code.split("\n").find((line) => line.trim()) ?? ""
  return `${lineCount} line${lineCount === 1 ? "" : "s"} · ${truncateInline(first, 90)}`
}

function toolArgsSummary(name: string, args: Record<string, unknown>): string {
  const parts: string[] = []
  const str = (key: string): string | undefined => {
    const value = args[key]
    return typeof value === "string" && value.trim() ? value : undefined
  }
  const action = str("action")
  if (action) parts.push(action)
  if (name === "python") {
    const code = str("code")
    if (code) parts.push(codeSummary(code))
  }
  const command = str("command")
  if (command) parts.push(`$ ${truncateInline(command, 160)}`)
  const path = str("path")
  if (path) parts.push(truncateInline(path, 80))
  const query = str("query")
  if (query) parts.push(`"${truncateInline(query, 60)}"`)
  const title = str("title")
  if (title) parts.push(`"${truncateInline(title, 60)}"`)
  const sessionId = str("session_id")
  if (sessionId) parts.push(sessionId)
  const jobId = str("job_id")
  if (jobId) parts.push(jobId)
  const taskId = str("task_id")
  if (taskId) parts.push(truncateInline(taskId, 44))
  const workId = str("id")
  if (workId && !jobId) parts.push(truncateInline(workId, 44))
  const mode = str("mode")
  if (mode) parts.push(mode)
  const status = str("status")
  if (status) parts.push(status)
  if (typeof args.limit === "number") parts.push(`limit ${args.limit}`)
  const note = str("note")
  if (note) parts.push(truncateInline(note, 60))
  const message = str("message")
  if (message) parts.push(`"${truncateInline(message, 60)}"`)
  return parts.join(" · ")
}

function toolLineLabel(name: string, argsValue: unknown): string {
  const args = argsValue && typeof argsValue === "object" ? (argsValue as Record<string, unknown>) : {}
  const summary = toolArgsSummary(name, args)
  return summary ? `${name} ${summary}` : name
}

function toolDedupeKey(text: string): string {
  return text.trimStart().slice(0, 300)
}

function discordContextLine(text: string): Pick<ChatLine, "kind" | "label" | "text" | "detail"> {
  const stats = text.match(/new_messages=(\d+).*?channels=(\d+).*?pending_inbox=(\d+)/s)
  const recent = text.match(/recent messages:\s*([\s\S]*?)(?:\n\npending preview:|$)/)
  const newMessages = stats?.[1] ?? "some"
  const channels = stats?.[2] ?? "?"
  const pending = stats?.[3] ?? "?"
  return {
    kind: "context",
    label: "discord context",
    text: `${newMessages} recent messages across ${channels} channel${channels === "1" ? "" : "s"} - ${pending} pending`,
    detail: recent?.[1]?.trim() || text.trim(),
  }
}

function isDiscordContextEnvelope(envelopeName: string): boolean {
  return (
    envelopeName.startsWith("incoming") ||
    envelopeName.startsWith("discord batch") ||
    envelopeName.startsWith("discord context")
  )
}

function userLineFromContent(content: string, fallbackLabel = "you"): Pick<ChatLine, "kind" | "label" | "text" | "detail"> {
  const trimmed = content.trim()
  const envelope = trimmed.match(/^\[([^\]]+)\]\s*([\s\S]*)$/)
  const envelopeName = envelope?.[1]?.toLowerCase() ?? ""
  const body = envelope?.[2]?.trim() ?? trimmed

  if (isDiscordContextEnvelope(envelopeName)) return discordContextLine(body)
  if (envelopeName.startsWith("system")) {
    return {
      kind: "context",
      label: "system",
      text: body.split("\n").find(Boolean)?.trim() || "system event",
      detail: body,
    }
  }
  if (envelopeName.startsWith("wake")) {
    return {
      kind: "note",
      label: "wake",
      text: envelope?.[1] ?? "wake",
      detail: body,
    }
  }
  if (envelopeName.startsWith("harness restarted")) {
    return {
      kind: "note",
      label: "harness",
      text: "restarted",
      detail: body,
    }
  }

  return {
    kind: "user",
    label: fallbackLabel,
    text: trimmed,
  }
}

function linesFromEvents(events: WorkerEvent[]): ChatLine[] {
  const lines: ChatLine[] = []
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const streamUserTexts = new Set<string>()
  const streamToolResults = new Set<string>()

  for (const event of sorted) {
    if (event.type !== "stream.event") continue
    const payload = eventPayloadObject(event)
    if (payload.type === "user" && typeof payload.text === "string" && payload.text.trim()) {
      streamUserTexts.add(payload.text.trim())
    }
    if (payload.type === "tool" && typeof payload.result === "string") {
      streamToolResults.add(toolDedupeKey(payload.result))
    }
  }

  // Coalesce adjacent thinking stream events into single lines.
  let thinkingBuffer = ""
  let thinkingStartEvent: WorkerEvent | null = null

  const flushThinking = () => {
    if (!thinkingStartEvent || !thinkingBuffer.trim()) {
      thinkingBuffer = ""
      thinkingStartEvent = null
      return
    }
    lines.push({
      key: thinkingStartEvent.id,
      seq: thinkingStartEvent.seq,
      at: thinkingStartEvent.createdAt,
      kind: "thinking",
      label: "thinking",
      text: thinkingBuffer,
    })
    thinkingBuffer = ""
    thinkingStartEvent = null
  }

  for (const event of sorted) {
    const payload = eventPayloadObject(event)

    // Handle thinking stream events — coalesce adjacent chunks.
    if (event.type === "stream.event" && payload.type === "thinking" && typeof payload.text === "string") {
      if (!thinkingStartEvent) thinkingStartEvent = event
      thinkingBuffer += payload.text
      continue
    }

    // Non-thinking event flushes any pending thinking buffer.
    flushThinking()

    if (event.type === "stream.event" && payload.type === "user" && typeof payload.text === "string") {
      const text = payload.text.trim()
      if (!text) continue
      const clean = userLineFromContent(text, String(payload.source ?? "you"))
      lines.push({
        key: event.id,
        seq: event.seq,
        at: event.createdAt,
        kind: clean.kind,
        label: clean.label === "chat" ? "you" : clean.label,
        text: clean.text,
        detail: clean.detail,
      })
      continue
    }

    if (event.type === "stream.event" && payload.type === "tool" && typeof payload.name === "string") {
      const resultText = typeof payload.result === "string" ? payload.result : ""
      lines.push({
        key: event.id,
        seq: event.seq,
        at: event.createdAt,
        kind: "tool",
        label: toolLineLabel(payload.name, payload.args),
        text: resultText,
        toolArgs: eventPayloadObject(event).args as Record<string, unknown> | undefined,
      })
      continue
    }

    if (event.type === "conversation.started") {
      lines.push({
        key: event.id,
        seq: event.seq,
        at: event.createdAt,
        kind: "note",
        label: "session",
        text: `started from ${String(payload.source ?? "unknown")}`,
      })
      continue
    }

    if (event.type === "conversation.ended") {
      lines.push({
        key: event.id,
        seq: event.seq,
        at: event.createdAt,
        kind: "note",
        label: "session",
        text: `ended with ${formatNumber(typeof payload.tokens === "number" ? payload.tokens : undefined)} tokens`,
      })
      continue
    }

    if (event.type !== "conversation.message") continue

    const role = String(payload.role ?? "")
    const content = String(payload.content ?? "")
    if (!content.trim()) continue

    if (role === "assistant") {
      lines.push({
        key: event.id,
        seq: event.seq,
        at: String(payload.createdAt ?? event.createdAt),
        kind: "agent",
        label: "agent",
        text: content,
      })
      continue
    }

    if (role === "tool") {
      if (streamToolResults.has(toolDedupeKey(content))) continue
      lines.push({
        key: event.id,
        seq: event.seq,
        at: String(payload.createdAt ?? event.createdAt),
        kind: "tool",
        label: toolLabel(content),
        text: content,
      })
      continue
    }

    if (role === "user") {
      if (streamUserTexts.has(content.trim())) continue
      if (content.trim().startsWith("[wake]")) continue
      const clean = userLineFromContent(content)
      lines.push({
        key: event.id,
        seq: event.seq,
        at: String(payload.createdAt ?? event.createdAt),
        kind: clean.kind,
        label: clean.label,
        text: clean.text,
        detail: clean.detail,
      })
    }
  }

  // Flush any trailing thinking buffer.
  flushThinking()

  return lines
}

function overviewStatusText(status: WorkerStatus | null): string {
  if (!status) return "not checked"
  if (status.error) return "unreachable"
  if (status.running) return status.idle ? "waiting" : "awake"
  return "resting"
}

function clientStatusText(status: WorkerStatus | null): string {
  const client = status?.client
  if (!client) return "client status unavailable"
  if (!client.connected) return "no tool client"
  const label = client.clientId || "tool client"
  const capabilityCount = client.capabilities?.length ?? 0
  return `${label} attached${capabilityCount ? ` · ${capabilityCount} tools` : ""}`
}

function codeLanguage(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json"
  if (/\.(tsx?|jsx?|mjs|cjs)\b/.test(trimmed)) return "typescript"
  if (/\.(css|html|json|md|py|rs|go|sh|bash|zsh)\b/.test(trimmed)) {
    const ext = trimmed.match(/\.(css|html|json|md|py|rs|go|sh|bash|zsh)\b/)?.[1]
    if (ext === "py") return "python"
    if (ext === "rs") return "rust"
    if (ext === "md") return "markdown"
    if (ext === "sh" || ext === "zsh") return "bash"
    return ext
  }
  if (/\b(import|export|const|let|function|type|interface)\b/.test(trimmed)) return "typescript"
  if (/\b(select|insert|update|create table|from|where)\b/i.test(trimmed)) return "sql"
  return undefined
}

function HighlightedCode({ text, language: requestedLanguage }: { text: string; language?: string }) {
  const language = requestedLanguage ?? codeLanguage(text)
  let html: string
  try {
    html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value
  } catch {
    html = text.replace(/[&<>"']/g, (char) => {
      if (char === "&") return "&amp;"
      if (char === "<") return "&lt;"
      if (char === ">") return "&gt;"
      if (char === "\"") return "&quot;"
      return "&#39;"
    })
  }

  return (
    <pre className="code-block">
      <code className={language ? `language-${language}` : undefined} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children }) {
            const match = /language-([a-z0-9_-]+)/i.exec(className ?? "")
            const code = String(children).replace(/\n$/, "")
            if (match) return <HighlightedCode text={code} language={match[1]} />
            return <code className={className}>{children}</code>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function prefixForLine(line: ChatLine, agentName: string): string {
  if (line.kind === "agent") return agentName
  if (line.kind === "user") return "you"
  if (line.kind === "tool") return "tool"
  if (line.kind === "thinking") return "thinking"
  if (line.kind === "context" && line.label.includes("discord")) return "discord"
  return line.label
}

function TerminalMessage({
  line,
  agentName,
  expanded,
  onToggle,
}: {
  line: ChatLine
  agentName: string
  expanded: boolean
  onToggle: (key: string) => void
}) {
  const prefix = prefixForLine(line, agentName)

  if (line.kind === "tool") {
    return (
      <article className="terminal-message terminal-message-tool">
        <div className="terminal-row">
          <span className="terminal-prefix terminal-prefix-tool">tool:</span>
          <div className="terminal-body">
            <button type="button" className="terminal-command" onClick={() => onToggle(line.key)}>
              <span>{line.label}</span>
              <small>{expanded ? "hide result" : "show result"}</small>
            </button>
            {expanded ? (
              <div className="terminal-block terminal-block-tool">
                <HighlightedCode text={line.text} />
              </div>
            ) : null}
          </div>
          <time className="terminal-time">{formatTime(line.at)}</time>
        </div>
      </article>
    )
  }

  if (line.kind === "thinking") {
    return (
      <article className="terminal-message terminal-message-thinking">
        <div className="terminal-row">
          <span className="terminal-prefix terminal-prefix-thinking">thinking:</span>
          <div className="terminal-body">
            <button type="button" className="terminal-command" onClick={() => onToggle(line.key)}>
              <span>reasoning trace</span>
              <small>{expanded ? "hide" : "show"}</small>
            </button>
            {expanded ? (
              <div className="terminal-block terminal-block-thinking">
                <MarkdownBody text={line.text} />
              </div>
            ) : null}
          </div>
          <time className="terminal-time">{formatTime(line.at)}</time>
        </div>
      </article>
    )
  }

  if (line.kind === "context" || line.detail) {
    return (
      <article className={`terminal-message terminal-message-${line.kind}`}>
        <div className="terminal-row">
          <span className={`terminal-prefix terminal-prefix-${line.kind}`}>{prefix}:</span>
          <div className="terminal-body">
            <p className="terminal-summary-text">{line.text}</p>
            {line.detail ? (
              <>
                <button type="button" className="terminal-inline-action" onClick={() => onToggle(line.key)}>
                  {expanded ? "hide" : "show"}
                </button>
                {expanded ? (
                  <div className="terminal-block">
                    <MarkdownBody text={line.detail} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <time className="terminal-time">{formatTime(line.at)}</time>
        </div>
      </article>
    )
  }

  return (
    <article className={`terminal-message terminal-message-${line.kind}`}>
      <div className="terminal-row">
        <span className={`terminal-prefix terminal-prefix-${line.kind}`}>{prefix}:</span>
        <div className="terminal-body">
          <MarkdownBody text={line.text} />
        </div>
        <time className="terminal-time">{formatTime(line.at)}</time>
      </div>
    </article>
  )
}

export function App() {
  const [panels, setPanels] = useState<Panel[]>(() => readPanels())
  const [panelDraft, setPanelDraft] = useState("")
  const [panelNameDraft, setPanelNameDraft] = useState("")
  const [agentsByPanel, setAgentsByPanel] = useState<Record<string, Agent[]>>({})
  const [selectedKey, setSelectedKey] = useState("")
  const [events, setEvents] = useState<WorkerEvent[]>([])
  const [overview, setOverview] = useState<Overview | null>(null)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [openCompaction, setOpenCompaction] = useState<string | null>(null)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set())
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([])
  const [selectedDiscordChannel, setSelectedDiscordChannel] = useState<string | null>(null)
  const [discordMessages, setDiscordMessages] = useState<DiscordMessage[]>([])
  const [discordLoading, setDiscordLoading] = useState(false)
  const [dagFrontier, setDagFrontier] = useState<ContextDagFrontier[]>([])
  const [selectedDagId, setSelectedDagId] = useState<string | null>(null)
  const [dagNode, setDagNode] = useState<ContextDagNode | null>(null)
  const [dagLoading, setDagLoading] = useState(false)
  const [notesWidth, setNotesWidth] = useState(() => readNotesWidth())
  const resizeStart = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const streamRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const discordMessagesRef = useRef<HTMLDivElement | null>(null)

  const startNotesResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStart.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: notesWidth }
    document.body.classList.add("is-resizing-notes")
  }, [notesWidth])

  const moveNotesResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    setNotesWidth(clampNotesWidth(start.startWidth + start.startX - event.clientX))
  }, [])

  const endNotesResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    resizeStart.current = null
    document.body.classList.remove("is-resizing-notes")
    event.currentTarget.releasePointerCapture(event.pointerId)
    setNotesWidth((width) => {
      window.localStorage.setItem(NOTES_WIDTH_STORAGE_KEY, String(width))
      return width
    })
  }, [])

  const handleNotesResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16
    if (event.key === "ArrowLeft") setNotesWidth((width) => clampNotesWidth(width + step))
    else if (event.key === "ArrowRight") setNotesWidth((width) => clampNotesWidth(width - step))
    else if (event.key === "Home") setNotesWidth(NOTES_WIDTH_MIN)
    else if (event.key === "End") setNotesWidth(NOTES_WIDTH_MAX)
    else return
    event.preventDefault()
    window.localStorage.setItem(NOTES_WIDTH_STORAGE_KEY, String(notesWidth))
  }, [notesWidth])

  useEffect(() => {
    window.localStorage.setItem(NOTES_WIDTH_STORAGE_KEY, String(notesWidth))
  }, [notesWidth])

  const selected = useMemo(() => {
    if (!selectedKey) return null
    const [panelId, agentId] = selectedKey.split("::")
    const panel = panels.find((item) => item.id === panelId)
    const agent = panel ? agentsByPanel[panel.id]?.find((item) => item.id === agentId) : undefined
    return panel && agent ? { panel, agent } : null
  }, [agentsByPanel, panels, selectedKey])

  const chatLines = useMemo(() => linesFromEvents(events), [events])
  const cacheStats = useMemo(() => cacheStatsFromEvents(events), [events])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = messagesRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [chatLines.length, selectedKey])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = discordMessagesRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [discordMessages.length, selectedDiscordChannel])

  const mergeEvents = useCallback((incoming: WorkerEvent[]) => {
    setEvents((prev) => {
      const byId = new Map(prev.map((event) => [event.id, event]))
      for (const event of incoming) byId.set(event.id, event)
      return [...byId.values()].sort((a, b) => a.seq - b.seq)
    })
  }, [])

  const persistPanels = useCallback((next: Panel[]) => {
    setPanels(next)
    savePanels(next)
  }, [])

  const loadAgents = useCallback(async () => {
    const next: Record<string, Agent[]> = {}
    const failures: string[] = []

    await Promise.all(
      panels.map(async (panel) => {
        try {
          const data = await requestJson<{ agents: Agent[] }>(urlFor(panel, "/agents"))
          next[panel.id] = data.agents ?? []
        } catch (err) {
          failures.push(`${panel.name}: ${err instanceof Error ? err.message : String(err)}`)
          next[panel.id] = []
        }
      }),
    )

    setAgentsByPanel(next)
    setError(failures[0] ?? "")

    if (!selectedKey) {
      const firstPanel = panels.find((panel) => next[panel.id]?.length)
      const firstAgent = firstPanel ? next[firstPanel.id]?.[0] : undefined
      if (firstPanel && firstAgent) setSelectedKey(`${firstPanel.id}::${firstAgent.id}`)
    }
  }, [panels, selectedKey])

  const loadSelected = useCallback(async () => {
    if (!selected) return
    setError("")
    try {
      const [overviewData, eventData, discordData, dagData] = await Promise.all([
        requestJson<Overview>(urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/overview`)),
        requestJson<{ events: WorkerEvent[] }>(
          urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/events?tail=1&limit=1000&view=chat`),
        ),
        requestJson<{ channels: DiscordChannel[] }>(
          urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/discord/channels`),
        ).catch(() => ({ channels: [] })),
        requestJson<{ frontier: ContextDagFrontier[] }>(
          urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/context/dag`),
        ).catch(() => ({ frontier: [] })),
      ])
      setOverview(overviewData)
      setEvents(eventData.events ?? [])
      setDiscordChannels(discordData.channels ?? [])
      setDagFrontier(dagData.frontier ?? [])
      setSelectedDagId((current) => current ?? dagData.frontier?.at(-1)?.id ?? null)
      setSelectedDiscordChannel((current) =>
        current && (discordData.channels ?? []).some((channel) => channel.channel_id === current)
          ? current
          : discordData.channels?.[0]?.channel_id ?? null,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOverview(null)
      setEvents([])
      setDiscordChannels([])
      setSelectedDiscordChannel(null)
      setDiscordMessages([])
      setDagFrontier([])
      setSelectedDagId(null)
      setDagNode(null)
    }
  }, [selected])

  useEffect(() => {
    if (!selected || !selectedDagId) {
      setDagNode(null)
      return
    }
    setDagLoading(true)
    void requestJson<{ node: ContextDagNode }>(
      urlFor(
        selected.panel,
        `/agents/${encodeURIComponent(selected.agent.id)}/context/dag/${encodeURIComponent(selectedDagId)}`,
      ),
    )
      .then((data) => setDagNode(data.node))
      .catch(() => setDagNode(null))
      .finally(() => setDagLoading(false))
  }, [selected, selectedDagId])

  useEffect(() => {
    if (!selected || !selectedDiscordChannel) {
      setDiscordMessages([])
      return
    }
    setDiscordLoading(true)
    void requestJson<{ messages: DiscordMessage[] }>(
      urlFor(
        selected.panel,
        `/agents/${encodeURIComponent(selected.agent.id)}/discord/channels/${encodeURIComponent(selectedDiscordChannel)}/messages?limit=100`,
      ),
    )
      .then((data) => setDiscordMessages((data.messages ?? []).slice().reverse()))
      .catch(() => setDiscordMessages([]))
      .finally(() => setDiscordLoading(false))
  }, [selected, selectedDiscordChannel])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  useEffect(() => {
    void loadSelected()
  }, [loadSelected])

  useEffect(() => {
    setSelectedDagId(null)
    setDagNode(null)
  }, [selectedKey])

  useEffect(() => {
    if (!selected) return
    streamRef.current?.abort()
    const controller = new AbortController()
    streamRef.current = controller
    const streamUrl = urlFor(
      selected.panel,
      `/agents/${encodeURIComponent(selected.agent.id)}/stream?after_seq=${selected.agent.lastSeq}`,
    )
    void consumeWorkerStream(streamUrl, controller.signal, (event) => {
      mergeEvents([event])
      if (event.type === "metric.recorded") void loadSelected()
    }).catch((error) => {
      if (!controller.signal.aborted) setError(`stream lost for ${selected.agent.name}: ${error instanceof Error ? error.message : String(error)}`)
    })

    return () => {
      controller.abort()
    }
  }, [loadSelected, mergeEvents, selected])

  useEffect(() => {
    if (!selected) return
    const timer = setInterval(() => {
      requestJson<Overview>(urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/overview`))
        .then(setOverview)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    }, 10_000)
    return () => clearInterval(timer)
  }, [selected])

  const addPanel = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const baseUrl = cleanBaseUrl(panelDraft)
      if (!baseUrl) return
      const next = [
        ...panels,
        {
          id: createId("panel"),
          name: panelNameDraft.trim() || baseUrl,
          baseUrl,
        },
      ]
      persistPanels(next)
      setPanelDraft("")
      setPanelNameDraft("")
    },
    [panelDraft, panelNameDraft, panels, persistPanels],
  )

  const removePanel = useCallback(
    (panelId: string) => {
      const next = panels.filter((panel) => panel.id !== panelId)
      persistPanels(next.length ? next : readPanels())
      if (selectedKey.startsWith(`${panelId}::`)) {
        setSelectedKey("")
        setEvents([])
        setOverview(null)
        setDiscordChannels([])
        setSelectedDiscordChannel(null)
        setDiscordMessages([])
      }
    },
    [panels, persistPanels, selectedKey],
  )

  const sendMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!selected) return
      const content = input.trim()
      if (!content || busy) return

      setBusy(true)
      setError("")
      setInput("")
      try {
        await requestJson(urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/events`), {
          method: "POST",
          body: JSON.stringify({ content }),
        })
        await loadSelected()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setInput(content)
      } finally {
        setBusy(false)
      }
    },
    [busy, input, loadSelected, selected],
  )

  const toggleTool = useCallback((key: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const compactions = overview?.compactions ?? []
  const status = overview?.status ?? null

  return (
    <main className="place" style={{ "--notes-width": `${notesWidth}px` } as React.CSSProperties}>
      <aside className="connections" aria-label="control panels">
        <header>
          <h1>niri</h1>
          <button type="button" onClick={() => void loadAgents()}>
            refresh
          </button>
        </header>

        <form className="connect-form" onSubmit={addPanel}>
          <input
            value={panelNameDraft}
            onChange={(event) => setPanelNameDraft(event.target.value)}
            placeholder="name"
            aria-label="control panel name"
          />
          <input
            value={panelDraft}
            onChange={(event) => setPanelDraft(event.target.value)}
            placeholder="https://control.example"
            aria-label="control panel url"
          />
          <button type="submit">connect</button>
        </form>

        <div className="agent-list">
          {panels.map((panel) => (
            <section key={panel.id}>
              <div className="panel-line">
                <span>{panel.name}</span>
                {panel.id !== "same-origin" ? (
                  <button type="button" onClick={() => removePanel(panel.id)} aria-label={`remove ${panel.name}`}>
                    remove
                  </button>
                ) : null}
              </div>
              {(agentsByPanel[panel.id] ?? []).map((agent) => {
                const key = `${panel.id}::${agent.id}`
                return (
                  <button
                    key={key}
                    type="button"
                    className={key === selectedKey ? "agent-button is-current" : "agent-button"}
                    onClick={() => setSelectedKey(key)}
                  >
                    <span>{agent.name}</span>
                    <small>{agent.status}</small>
                  </button>
                )
              })}
              {(agentsByPanel[panel.id] ?? []).length === 0 ? <p className="quiet">no agents</p> : null}
            </section>
          ))}
        </div>
      </aside>

      <section className="thread" aria-label="agent conversation">
        <header className="thread-head">
          <div>
            <h2>{selected ? selected.agent.name : "choose an agent"}</h2>
            <p>
              {overviewStatusText(status)}
              {status?.processStartedAt ? ` since ${formatTime(status.processStartedAt)}` : ""}
            </p>
            <p className="quiet">{clientStatusText(status)}</p>
          </div>
          <div className="readout" aria-label="current token status">
            <span>{formatNumber(status?.contextSize)} ctx</span>
            <span>{formatNumber(status?.tokenCount)} total</span>
            <span>{cacheStats ? `${formatPercent(cacheStats.latestRate)} cache` : "cache —"}</span>
            <span>{formatDuration(status?.uptimeMs)}</span>
          </div>
        </header>

        {error ? <p className="error-line">{error}</p> : null}

        <div className="chat-pane">
          <div className="messages" ref={messagesRef}>
            {chatLines.length === 0 ? (
              <p className="empty">No mirrored history yet. Send a message or open the stream to start collecting it.</p>
            ) : (
              chatLines.map((line) => {
                const expanded = expandedTools.has(line.key)
                return (
                  <TerminalMessage
                    key={line.key}
                    line={line}
                    agentName={selected?.agent.name ?? "agent"}
                    expanded={expanded}
                    onToggle={toggleTool}
                  />
                )
              })
            )}
          </div>
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={!selected || busy}
            placeholder={selected ? `message ${selected.agent.name}` : "choose an agent first"}
            aria-label="message"
          />
          <button type="submit" disabled={!selected || busy || !input.trim()}>
            {busy ? "sending" : "send"}
          </button>
        </form>
      </section>

      <aside className="notes" aria-label="agent notes">
        <div
          className="notes-resizer"
          role="separator"
          aria-label="resize right rail"
          aria-orientation="vertical"
          aria-valuemin={NOTES_WIDTH_MIN}
          aria-valuemax={NOTES_WIDTH_MAX}
          aria-valuenow={notesWidth}
          tabIndex={0}
          onPointerDown={startNotesResize}
          onPointerMove={moveNotesResize}
          onPointerUp={endNotesResize}
          onPointerCancel={endNotesResize}
          onKeyDown={handleNotesResizeKeyDown}
        />
        <section>
          <h2>status</h2>
          <dl>
            <div>
              <dt>state</dt>
              <dd>{overviewStatusText(status)}</dd>
            </div>
            <div>
              <dt>context</dt>
              <dd>{formatNumber(status?.contextSize)}</dd>
            </div>
            <div>
              <dt>tokens</dt>
              <dd>{formatNumber(status?.tokenCount)}</dd>
            </div>
            <div>
              <dt>uptime</dt>
              <dd>{formatDuration(status?.uptimeMs)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2>prompt cache</h2>
          {!cacheStats ? <p className="quiet">no cache telemetry yet</p> : (
            <>
              <dl>
                <div>
                  <dt>latest hit</dt>
                  <dd>{formatPercent(cacheStats.latestRate)}</dd>
                </div>
                <div>
                  <dt>recent hit</dt>
                  <dd>{formatPercent(cacheStats.recentRate)}</dd>
                </div>
                <div>
                  <dt>cached</dt>
                  <dd>{formatNumber(cacheStats.recentCachedTokens)} / {formatNumber(cacheStats.recentPromptTokens)}</dd>
                </div>
                <div>
                  <dt>cache write</dt>
                  <dd>{formatNumber(cacheStats.recentCacheWriteTokens)}</dd>
                </div>
              </dl>
              <div className="cache-history" aria-label={`cache hit history for ${cacheStats.samples.length} recent calls`}>
                {cacheStats.samples.map((sample) => {
                  const rate = sample.cachedPromptTokens / sample.promptTokens
                  return (
                    <span
                      key={sample.key}
                      style={{ "--cache-height": `${Math.max(4, Math.round(rate * 100))}%` } as React.CSSProperties}
                      title={`${formatTime(sample.at)} · ${formatPercent(rate)} · ${formatNumber(sample.cachedPromptTokens)} cached`}
                    />
                  )
                })}
              </div>
              <p className="quiet">weighted across the latest {cacheStats.samples.length} calls</p>
            </>
          )}
        </section>

        <section>
          <h2>discord history</h2>
          {discordChannels.length === 0 ? <p className="quiet">no channels mirrored yet</p> : null}
          <div className="discord-history">
            <div className="discord-channels">
              {discordChannels.map((channel) => (
                <button
                  key={channel.channel_id}
                  type="button"
                  className={channel.channel_id === selectedDiscordChannel ? "discord-channel is-current" : "discord-channel"}
                  onClick={() => setSelectedDiscordChannel(channel.channel_id)}
                >
                  <span>{discordChannelLabel(channel)}</span>
                  <small>{channel.guild_name || "dm"}</small>
                </button>
              ))}
            </div>
            {selectedDiscordChannel ? (
              <div className="discord-messages" ref={discordMessagesRef}>
                {discordLoading ? <p className="quiet">loading...</p> : null}
                {!discordLoading && discordMessages.length === 0 ? <p className="quiet">no messages</p> : null}
                {discordMessages.map((message) => (
                  <article key={message.message_id}>
                    <div>
                      <strong>{message.author_username || "unknown"}</strong>
                      <time>{formatTime(message.created_at)}</time>
                    </div>
                    <p>{message.content || "(attachment or empty message)"}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section>
          <h2>memory dag</h2>
          {dagFrontier.length === 0 ? <p className="quiet">no active memory segments</p> : null}
          <div className="dag-frontier" aria-label="active memory frontier">
            {dagFrontier.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={item.id === selectedDagId ? "dag-node-button is-current" : "dag-node-button"}
                onClick={() => setSelectedDagId(item.id)}
              >
                <span>{index + 1}</span>
                <strong>{item.id.slice(4, 12)}</strong>
                <small>depth {item.depth} · {formatTime(item.summary?.createdAt)}</small>
              </button>
            ))}
          </div>
          {dagLoading ? <p className="quiet">loading node...</p> : null}
          {!dagLoading && dagNode ? (
            <div className="dag-detail">
              <header>
                <div>
                  <strong>{dagNode.id}</strong>
                  <small>{dagNode.summary.method} · depth {dagNode.summary.depth}</small>
                </div>
                <time>{formatTime(dagNode.summary.createdAt)}</time>
              </header>
              <dl className="dag-stats">
                <div><dt>direct</dt><dd>{formatNumber(dagNode.summary.directSources.messageCount)} messages</dd></div>
                <div><dt>reachable</dt><dd>{formatNumber(dagNode.summary.expandedSources.messageCount)} messages</dd></div>
                <div><dt>nodes</dt><dd>{formatNumber(dagNode.summary.provenanceNodeCount)}</dd></div>
              </dl>
              {dagNode.summary.parentSegments.length ? (
                <div className="dag-links">
                  <span>parents, oldest → newest</span>
                  {dagNode.summary.parentSegments.map((parent, index) => (
                    <button key={parent.id} type="button" onClick={() => setSelectedDagId(parent.id)}>
                      <span>{index + 1}</span>
                      <strong>{parent.id.slice(4, 12)}</strong>
                      <small>depth {parent.depth}</small>
                    </button>
                  ))}
                </div>
              ) : <p className="dag-leaf">leaf node · raw messages directly beneath</p>}
              {dagNode.summary.childIds.length ? (
                <div className="dag-links">
                  <span>used by</span>
                  {dagNode.summary.childIds.map((childId) => (
                    <button key={childId} type="button" onClick={() => setSelectedDagId(childId)}>
                      <span>↑</span>
                      <strong>{childId.slice(4, 12)}</strong>
                    </button>
                  ))}
                </div>
              ) : null}
              <details>
                <summary>read summary</summary>
                <MarkdownBody text={dagNode.summary.content} />
              </details>
            </div>
          ) : null}
        </section>

        <section>
          <h2>recent compactions</h2>
          {compactions.length === 0 ? <p className="quiet">none mirrored yet</p> : null}
          <div className="compactions">
            {compactions.map((item) => {
              const key = item.eventId
              const open = openCompaction === key
              return (
                <article key={key}>
                  <button type="button" onClick={() => setOpenCompaction(open ? null : key)}>
                    <span>{formatTime(item.timestamp)}</span>
                    <strong>{formatNumber(item.savedTokens)} saved</strong>
                    <small>{item.method ?? "compaction"}</small>
                  </button>
                  {open ? <MarkdownBody text={item.summary || "(no summary stored)"} /> : null}
                </article>
              )
            })}
          </div>
        </section>
      </aside>
    </main>
  )
}
