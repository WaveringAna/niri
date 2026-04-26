import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createChatClient, type StreamEvent } from "@niri/chat-client"
import { MarkdownBlock } from "./MarkdownBlock"
import { MetricsWorkbench } from "./MetricsWorkbench"

type Entry =
  | { id: number; kind: "info"; text: string }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "incoming"; source: string; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; name: string; args: Record<string, unknown>; result: string }

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never

type NewEntry = WithoutId<Entry>

const toolSummary = (name: string, args: Record<string, unknown>): string => {
  switch (name) {
    case "shell":
      return `$ ${String(args.command ?? "")}`
    case "read_file": {
      const start = args.start_line ? `:${String(args.start_line)}` : ""
      const end = args.end_line ? `-${String(args.end_line)}` : ""
      return `read ${String(args.path ?? "")}${start}${end}`
    }
    case "edit_file":
      return `edit ${String(args.path ?? "")}`
    case "memory_search":
      return `memory ${String(args.query ?? "")}`
    case "rest":
      return `rest${args.note ? ` ${String(args.note)}` : ""}`
    default:
      return `${name} ${JSON.stringify(args)}`
  }
}

const hiddenToolSummary = (result: string): string => {
  const normalized = result || "(no output)"
  const lines = normalized.split("\n")
  if (lines.length <= 1) return lines[0] ?? "(no output)"
  return `${lines[0] ?? "(no output)"}\n… ${lines.length - 1} more lines hidden`
}

const toToolMarkdown = (result: string): string => {
  const normalized = result || "(no output)"
  return normalized.includes("```") ? normalized : `\`\`\`text\n${normalized}\n\`\`\``
}

const baseUrl = import.meta.env.VITE_NIRI_BASE_URL ?? ""

const createClientId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `web-${crypto.randomUUID()}`
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function App() {
  const clientId = useMemo(() => createClientId(), [])
  const client = useMemo(() => createChatClient({ baseUrl, clientId }), [clientId])
  const [view, setView] = useState<"metrics" | "chat">(() => (window.location.hash === "#chat" ? "chat" : "metrics"))

  const [entries, setEntries] = useState<Entry[]>([])
  const [running, setRunning] = useState<boolean | null>(null)
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [showThinking, setShowThinking] = useState(false)
  const [showAllTools, setShowAllTools] = useState(false)
  const [collapsedToolIds, setCollapsedToolIds] = useState<Set<number>>(() => new Set<number>())
  const nextId = useRef(0)

  const push = useCallback((entry: NewEntry): number => {
    const id = nextId.current++
    setEntries((prev) => [...prev, { ...entry, id }])
    return id
  }, [])

  const appendStreamText = useCallback((kind: "text" | "thinking", text: string) => {
    setEntries((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === kind) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }]
      }

      const id = nextId.current++
      return [...prev, { id, kind, text }]
    })
  }, [])

  const toggleTool = useCallback((id: number) => {
    setCollapsedToolIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const collapseAllTools = useCallback(() => {
    setCollapsedToolIds(new Set(entries.filter((entry) => entry.kind === "tool").map((entry) => entry.id)))
  }, [entries])

  const expandAllTools = useCallback(() => {
    setCollapsedToolIds(new Set<number>())
  }, [])

  const switchView = useCallback((next: "metrics" | "chat") => {
    setView(next)
    window.history.replaceState(null, "", next === "chat" ? "#chat" : "#metrics")
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    client
      .stream({
        signal: controller.signal,
        onEvent: (event: StreamEvent) => {
          if (event.type === "thinking") {
            appendStreamText("thinking", event.text)
            return
          }

          if (event.type === "tool") {
            const id = push({ kind: "tool", name: event.name, args: event.args, result: event.result })
            setCollapsedToolIds((prev) => {
              const next = new Set(prev)
              next.add(id)
              return next
            })
            return
          }

          if (event.type === "user") {
            if (event.clientId === clientId) return
            push({ kind: "incoming", source: event.source, text: event.text })
            return
          }

          appendStreamText("text", event.text)
        },
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) })
      })

    return () => controller.abort()
  }, [appendStreamText, client, clientId, push])

  useEffect(() => {
    client
      .getStatus()
      .then((status) => setRunning(status.running))
      .catch((err) => push({ kind: "error", text: err instanceof Error ? err.message : String(err) }))
  }, [client, push])

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const message = input.trim()
      if (!message || sending) return

      setSending(true)
      setInput("")
      push({ kind: "user", text: message })

      try {
        await client.send(message)
      } catch (err) {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) })
      } finally {
        setSending(false)
      }
    },
    [client, input, push, sending],
  )

  return (
    <div className="shell">
      <nav className="top-nav" aria-label="primary">
        <button type="button" className={view === "metrics" ? "is-active" : ""} onClick={() => switchView("metrics")}>
          metrics
        </button>
        <button type="button" className={view === "chat" ? "is-active" : ""} onClick={() => switchView("chat")}>
          chat
        </button>
      </nav>

      {view === "metrics" ? (
        <MetricsWorkbench />
      ) : (
        <main className="app">
      <header className="header">
        <h1>niri chat</h1>
        <p className="status">
          {running === null ? "checking status…" : running ? "niri is awake" : "niri is sleeping — your message will wake her"}
        </p>
        <div className="toggles">
          <label>
            <input type="checkbox" checked={showThinking} onChange={(event) => setShowThinking(event.target.checked)} /> show thinking
          </label>
          <label>
            <input type="checkbox" checked={showAllTools} onChange={(event) => setShowAllTools(event.target.checked)} /> expand all tool calls
          </label>
          <button type="button" onClick={collapseAllTools}>collapse tools</button>
          <button type="button" onClick={expandAllTools}>expand tools</button>
        </div>
      </header>

      <section className="feed" aria-live="polite">
        {entries.map((entry) => {
          if (entry.kind === "thinking") {
            if (!showThinking) {
              return (
                <article key={entry.id} className="entry entry-info">
                  ⟨ thinking — {entry.text.split("\n").length} lines ⟩
                </article>
              )
            }

            return (
              <article key={entry.id} className="entry entry-thinking">
                <strong>thinking</strong>
                <MarkdownBlock content={entry.text} />
              </article>
            )
          }

          if (entry.kind === "tool") {
            const collapsed = !showAllTools && collapsedToolIds.has(entry.id)

            return (
              <article key={entry.id} className="entry entry-tool">
                <div className="entry-header">
                  <strong>tool #{entry.id}: {toolSummary(entry.name, entry.args)}</strong>
                  <button type="button" onClick={() => toggleTool(entry.id)}>
                    {collapsed ? "expand" : "collapse"}
                  </button>
                </div>
                {collapsed ? <pre>{hiddenToolSummary(entry.result)}</pre> : <MarkdownBlock content={toToolMarkdown(entry.result)} />}
              </article>
            )
          }

          if (entry.kind === "text") {
            return (
              <article key={entry.id} className="entry entry-niri">
                <strong>niri</strong>
                <MarkdownBlock content={entry.text} />
              </article>
            )
          }

          if (entry.kind === "incoming") {
            return (
              <article key={entry.id} className="entry entry-incoming">
                <strong>{entry.source}</strong>
                <MarkdownBlock content={entry.text} />
              </article>
            )
          }

          if (entry.kind === "user") {
            return (
              <article key={entry.id} className="entry entry-user">
                <strong>you</strong>
                <pre>{entry.text}</pre>
              </article>
            )
          }

          return (
            <article key={entry.id} className={`entry ${entry.kind === "error" ? "entry-error" : "entry-info"}`}>
              {entry.kind === "error" ? `error: ${entry.text}` : entry.text}
            </article>
          )
        })}
      </section>

      <form className="composer" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="send a message to niri"
          aria-label="message"
        />
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? "sending…" : "send"}
        </button>
      </form>
    </main>
      )}
    </div>
  )
}
