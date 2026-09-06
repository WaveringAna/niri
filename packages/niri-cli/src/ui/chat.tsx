import { useEffect, useMemo, useRef, useState } from "react"
import { Box, Static, Text, useInput, useWindowSize } from "ink"
import { createChatClient, type StreamEvent } from "@niri/chat-client"
import { TextInput } from "./text-input.js"
import { renderMarkdownAnsi } from "./markdown.js"

export type ChatScreenProps = {
  baseUrl: string
  token?: string
  agentId?: string
  /** Display name for the agent; falls back to its id. */
  agentName?: string
  fetchImpl?: typeof fetch
  /** Leave the chat. When it is the same function as onQuit there is no agents view to return to. */
  onBack: () => void
  onQuit: () => void
  /** How long after the last chunk the transcript asks the server whether the turn is over. */
  settleMs?: number
}

/**
 * A transcript record. Records keep the raw material of a turn; how much of it
 * is on screen is a display decision, so /v and /t change the same lines in
 * place instead of printing them again.
 */
type Record_ =
  | { kind: "assistant" | "note" | "error"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; summary: string; body: string; hidden: number }
  | { kind: "user"; source: string; text: string }
type Entry = Record_ & { id: number }
type Flags = { tools: boolean; thinking: boolean }

/** The line still being written. Thinking is always kept; /t decides whether it shows. */
type Active = { kind: "text" | "thinking"; text: string }

const lineCount = (text: string): number => text.split("\n").length
const formatNumber = (value: number): string => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const formatUsage = (event: Extract<StreamEvent, { type: "usage" }>): string => {
  const parts: string[] = []
  if (typeof event.tokensPerSecond === "number") parts.push(`${formatNumber(event.tokensPerSecond)} tok/s`)
  if (typeof event.completionTokens === "number") parts.push(`${event.completionTokens} out`)
  if (typeof event.promptTokens === "number") parts.push(`${event.promptTokens} ctx`)
  if (typeof event.cachedPromptTokens === "number") parts.push(`${event.cachedPromptTokens} cached`)
  if (typeof event.cacheWriteTokens === "number") parts.push(`${event.cacheWriteTokens} cache write`)
  if (typeof event.totalTokens === "number") parts.push(`${event.totalTokens} total`)
  if (typeof event.elapsedMs === "number") parts.push(`${(event.elapsedMs / 1000).toFixed(1)}s`)
  return parts.length ? parts.join(" \u00b7 ") : "usage unavailable"
}

const toolSummary = (name: string, args: Record<string, unknown>): string => {
  switch (name) {
    case "shell": return `$ ${String(args.command ?? "")}`
    case "read_file": return `read ${String(args.path ?? "")}${args.start_line ? `:${String(args.start_line)}` : ""}${args.end_line ? `-${String(args.end_line)}` : ""}`
    case "edit_file": return `edit ${String(args.path ?? "")}`
    case "memory_search": return `memory ${String(args.query ?? "")}`
    case "rest": return `rest${args.note ? ` ${String(args.note)}` : ""}`
    default: return `${name} ${JSON.stringify(args)}`
  }
}

const renderToolBody = (text: string): string => text.includes("```") ? renderMarkdownAnsi(text) : renderMarkdownAnsi(`\`\`\`text\n${text}\n\`\`\``)
const awakeness = (status: { running: boolean }, speaker: string): string =>
  status.running ? `${speaker} is awake` : `${speaker} is sleeping \u2014 your message will wake them`

/** The control server answers 404 for an agent whose runtime is down; say what to do about it. */
const describeFailure = (error: unknown, agentId?: string): string => {
  const text = message(error)
  return agentId && /agent not found|^404\b/i.test(text) ? `agent ${agentId} is not running \u2014 start it with \`niri agents start ${agentId}\`` : text
}

const createClientId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `cli-${crypto.randomUUID()}`
    : `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const thinkingLine = (text: string): string => `\u27e8 thinking \u27e9${text ? ` ${text}` : ""}`
const collapsedTool = (hidden: number): string => `\u2026 ${hidden} lines hidden \u00b7 /v to expand`
// A one-line message reads as one line; a longer body starts under its label.
const userLine = (source: string, text: string): string => `${source}:${text.includes("\n") ? "\n" : " "}${text}`

/** The exact text a record puts on screen right now — the measure and the view agree by construction. */
const entryText = (entry: Record_, flags: Flags, speaker: string): string => {
  switch (entry.kind) {
    case "assistant": return `${speaker}: ${entry.text}`
    case "thinking": return thinkingLine(flags.thinking ? entry.text : "")
    case "tool": return `${entry.summary}\n${flags.tools ? entry.body : collapsedTool(entry.hidden)}`
    case "note": case "error": return entry.text
    case "user": return userLine(entry.source, entry.text)
  }
}

const EntryView = ({ entry, flags, speaker }: { entry: Record_; flags: Flags; speaker: string }) => {
  switch (entry.kind) {
    case "assistant": return <Text><Text color="magentaBright">{speaker}: </Text>{entry.text}</Text>
    case "thinking": return <Text color="gray">{thinkingLine(flags.thinking ? entry.text : "")}</Text>
    case "tool": return (
      <Box flexDirection="column">
        <Text color="yellow">{entry.summary}</Text>
        {flags.tools ? <Text>{entry.body}</Text> : <Text color="gray">{collapsedTool(entry.hidden)}</Text>}
      </Box>
    )
    case "note": return <Text color="gray">{entry.text}</Text>
    case "error": return <Text color="red">{entry.text}</Text>
    case "user": return <Text><Text color="cyan">{entry.source}:</Text>{entry.text.includes("\n") ? "\n" : " "}{entry.text}</Text>
  }
}

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "")
const rowsUsed = (text: string, columns: number): number =>
  plain(text).split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0)

/**
 * Split the transcript where the terminal does: the newest records that fit the
 * window stay live and editable, everything older is already printed history.
 */
const liveFrom = (entries: Entry[], flags: Flags, speaker: string, columns: number, budget: number): number => {
  let used = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    used += rowsUsed(entryText(entries[index]!, flags, speaker), columns)
    if (used > budget) return index + 1
  }
  return 0
}

export function ChatScreen({ baseUrl, token, agentId, agentName, fetchImpl, onBack, onQuit, settleMs = 250 }: ChatScreenProps) {
  const speaker = agentName?.trim() || agentId?.trim() || "agent"
  const clientId = useRef(createClientId())
  const [entries, setEntries] = useState<Entry[]>([])
  const [active, setActive] = useState<Active | null>(null)
  const [draft, setDraft] = useState("")
  // Display state: toggling redraws the live records, it never reprints them.
  const [flags, setFlags] = useState<Flags>({ tools: false, thinking: false })
  const activeLine = useRef<Active | null>(null)
  // The last reply we watched stream in; its log record would repeat it.
  const streamed = useRef<string | undefined>(undefined)
  const live = useRef(true)
  const sequence = useRef(0)
  // How many records have scrolled into printed history.
  const printed = useRef(0)
  const returnsToAgents = onBack !== onQuit

  const client = useMemo(() => {
    const send = fetchImpl ?? fetch
    const authorized: typeof fetch = token
      ? (input, init) => send(input, { ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` }), redirect: "error" })
      : (input, init) => send(input, { ...init, redirect: "error" })
    return createChatClient({ baseUrl, clientId: clientId.current, ...(agentId ? { agentId } : {}), fetchImpl: authorized })
  }, [baseUrl, token, agentId, fetchImpl])

  const push = (...records: Record_[]): void => {
    if (!live.current) return
    setEntries((current) => [...current, ...records.map((record) => ({ ...record, id: sequence.current++ }))])
  }
  const setActiveLine = (next: Active | null): void => { if (!live.current) return; activeLine.current = next; setActive(next) }
  const settle = (): void => {
    const current = activeLine.current
    if (!current) return
    if (current.kind === "text") streamed.current = current.text
    push(current.kind === "text" ? { kind: "assistant", text: current.text } : { kind: "thinking", text: current.text })
    setActiveLine(null)
  }
  const append = (kind: Active["kind"], chunk: string): void => {
    let current = activeLine.current
    if (current?.kind !== kind) {
      settle()
      current = { kind, text: "" }
      setActiveLine(current)
    }
    if (chunk) setActiveLine({ ...current, text: current.text + chunk })
  }

  const handle = (event: StreamEvent): void => {
    switch (event.type) {
      case "thinking": return append("thinking", event.text)
      case "text": return append("text", event.text)
      case "tool":
        // Both forms are kept: the toggle chooses, it does not re-fetch or reprint.
        settle()
        return push({
          kind: "tool",
          summary: `tool: ${toolSummary(event.name, event.args)}`,
          body: renderToolBody(event.result || "(no output)"),
          hidden: lineCount(event.result),
        })
      case "user":
        // Our own message is already on screen; only other clients echo in.
        if (event.clientId === clientId.current) return
        settle()
        return push({ kind: "user", source: event.source, text: renderMarkdownAnsi(event.text) })
      case "usage":
        settle()
        return push({ kind: "note", text: `stats: ${formatUsage(event)}` })
      case "error":
        // The agent aborted its turn: end the dangling stream and say why.
        settle()
        return push({ kind: "error", text: event.text })
      case "message":
        // Replayed history carries the words a live stream would have shown.
        if (activeLine.current?.kind === "text") return settle()
        if (event.text === streamed.current) { streamed.current = undefined; return }
        return push({ kind: "assistant", text: event.text })
    }
  }

  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    // Status and stream fail together when the agent is down; one report is enough.
    let reported: string | undefined
    const fail = (error: unknown): void => {
      const text = describeFailure(error, agentId)
      if (controller.signal.aborted || text === reported) return
      reported = text
      push({ kind: "error", text })
    }
    push({ kind: "note", text: `tips: /v toggle tool output \u00b7 /t toggle thinking \u00b7 /status${returnsToAgents ? " \u00b7 /a agents (or \u2190)" : ""} \u00b7 /q quit` })
    client.getStatus().then((status) => { if (!controller.signal.aborted) push({ kind: "note", text: awakeness(status, speaker) }) }).catch(fail)
    client.stream({ signal: controller.signal, onEvent: (event) => { if (!controller.signal.aborted) handle(event) } }).catch(fail)
    return () => { live.current = false; controller.abort() }
  }, [client, agentId])

  // A stream ends without saying so; when chunks stop, the server settles the question.
  useEffect(() => {
    if (!active) return
    let waiting = true
    let timer = setTimeout(function poll() {
      client.getStatus()
        .then((status) => { if (waiting) (!status.running || status.idle) ? settle() : (timer = setTimeout(poll, settleMs)) })
        .catch(() => { if (waiting) timer = setTimeout(poll, settleMs) })
    }, settleMs)
    return () => { waiting = false; clearTimeout(timer) }
  }, [active, client, settleMs])

  // Ctrl-C ends the session the way the old readline SIGINT did.
  useInput((input, key) => { if (key.ctrl && input === "c") onQuit() })

  const submit = (value: string): void => {
    const trimmed = value.trim()
    setDraft("")
    if (!trimmed) return
    if (trimmed === "/a" || trimmed === "/agents") return onBack()
    if (trimmed === "/q" || trimmed === "/quit" || trimmed === "/exit") return onQuit()
    if (trimmed === "/status") {
      void client.getStatus().then((status) => push({ kind: "note", text: awakeness(status, speaker) })).catch((error) => push({ kind: "error", text: describeFailure(error, agentId) }))
      return
    }
    if (trimmed === "/v" || trimmed === "/verbose") {
      const tools = !flags.tools
      setFlags((current) => ({ ...current, tools }))
      return push({ kind: "note", text: `tool output: ${tools ? "expanded" : "collapsed"}` })
    }
    if (trimmed === "/t" || trimmed === "/thinking") {
      const thinking = !flags.thinking
      setFlags((current) => ({ ...current, thinking }))
      return push({ kind: "note", text: `thinking traces: ${thinking ? "visible" : "hidden"}` })
    }
    push({ kind: "user", source: "you", text: renderMarkdownAnsi(trimmed) })
    void client.send(trimmed).catch((error) => push({ kind: "error", text: describeFailure(error, agentId) }))
  }

  const { columns, rows } = useWindowSize()
  const activeText = active ? (active.kind === "text" ? `${speaker}: ${active.text}` : thinkingLine(flags.thinking ? active.text : "")) : ""
  // The live window is what the terminal can hold besides the composer and the streaming line.
  const budget = Math.max(1, rows - 1 - (active ? rowsUsed(activeText, columns) : 0))
  // History only grows: a record that has scrolled out was printed as it looked then.
  printed.current = Math.max(printed.current, liveFrom(entries, flags, speaker, columns, budget))
  const history = entries.slice(0, printed.current)
  const shown = entries.slice(printed.current)

  return (
    <Box flexDirection="column">
      <Static items={history}>{(entry) => <Box key={entry.id}><EntryView entry={entry} flags={flags} speaker={speaker} /></Box>}</Static>
      {shown.map((entry) => <EntryView key={entry.id} entry={entry} flags={flags} speaker={speaker} />)}
      {active ? (
        active.kind === "text"
          ? <Text><Text color="magentaBright">{speaker}: </Text>{active.text}</Text>
          : <Text color="gray">{thinkingLine(flags.thinking ? active.text : "")}</Text>
      ) : null}
      <Box>
        <Text color="cyanBright">you: </Text>
        <TextInput value={draft} onChange={setDraft} onSubmit={submit} onLeftWhenEmpty={onBack} />
      </Box>
    </Box>
  )
}
