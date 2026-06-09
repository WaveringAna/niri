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

type WorkerEvent = {
  id: string
  agentId: string
  seq: number
  type: string
  createdAt: string
  payload: unknown
}

type Overview = {
  agent: Agent
  status: WorkerStatus
  compactions: Compaction[]
}

type ChatLine = {
  key: string
  seq: number
  at: string
  kind: "agent" | "user" | "tool" | "note" | "context" | "error" | "thinking"
  label: string
  text: string
  detail?: string
}

const PANEL_COOKIE = "niri_control_panels"
const WORKER_EVENT_TYPES = [
  "worker.hello",
  "worker.heartbeat",
  "runner.status",
  "stream.event",
  "conversation.started",
  "conversation.message",
  "conversation.ended",
]

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
  return raw.trim().replace(/\/+$/, "")
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
    } catch {
      // Ignore old or malformed cookies.
    }
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
  const first = text.split("\n").find(Boolean)
  if (!first) return "tool"
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

  for (const event of sorted) {
    if (event.type !== "stream.event") continue
    const payload = eventPayloadObject(event)
    if (payload.type === "user" && typeof payload.text === "string" && payload.text.trim()) {
      streamUserTexts.add(payload.text.trim())
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
  const streamRef = useRef<EventSource | null>(null)

  const selected = useMemo(() => {
    if (!selectedKey) return null
    const [panelId, agentId] = selectedKey.split("::")
    const panel = panels.find((item) => item.id === panelId)
    const agent = panel ? agentsByPanel[panel.id]?.find((item) => item.id === agentId) : undefined
    return panel && agent ? { panel, agent } : null
  }, [agentsByPanel, panels, selectedKey])

  const chatLines = useMemo(() => linesFromEvents(events), [events])

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
      const [overviewData, eventData] = await Promise.all([
        requestJson<Overview>(urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/overview`)),
        requestJson<{ events: WorkerEvent[] }>(
          urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/events?tail=1&limit=1000&view=chat`),
        ),
      ])
      setOverview(overviewData)
      setEvents(eventData.events ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOverview(null)
      setEvents([])
    }
  }, [selected])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  useEffect(() => {
    void loadSelected()
  }, [loadSelected])

  useEffect(() => {
    if (!selected) return
    streamRef.current?.close()

    const source = new EventSource(
      urlFor(selected.panel, `/agents/${encodeURIComponent(selected.agent.id)}/stream?after_seq=${selected.agent.lastSeq}`),
    )
    streamRef.current = source

    const onWorkerEvent = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as WorkerEvent
        mergeEvents([event])
        if (event.type === "metric.recorded") void loadSelected()
      } catch {
        // Ignore keepalives or malformed events.
      }
    }

    for (const type of WORKER_EVENT_TYPES) {
      source.addEventListener(type, onWorkerEvent as EventListener)
    }
    source.onerror = () => setError(`stream lost for ${selected.agent.name}`)

    return () => {
      for (const type of WORKER_EVENT_TYPES) {
        source.removeEventListener(type, onWorkerEvent as EventListener)
      }
      source.close()
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
    <main className="place">
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
          </div>
          <div className="readout" aria-label="current token status">
            <span>{formatNumber(status?.contextSize)} ctx</span>
            <span>{formatNumber(status?.tokenCount)} total</span>
            <span>{formatDuration(status?.uptimeMs)}</span>
          </div>
        </header>

        {error ? <p className="error-line">{error}</p> : null}

        <div className="messages">
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

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={!selected || busy}
            placeholder={selected ? `message ${selected.agent.name}` : "choose an agent first"}
            aria-label="message"
            rows={3}
          />
          <button type="submit" disabled={!selected || busy || !input.trim()}>
            {busy ? "sending" : "send"}
          </button>
        </form>
      </section>

      <aside className="notes" aria-label="agent notes">
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
