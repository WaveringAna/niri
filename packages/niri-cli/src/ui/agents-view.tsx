import { useEffect, useState } from "react"
import { Box, Text, useInput, useStdout, useWindowSize } from "ink"
import { toRow, truncate, type AgentRow, type Tone } from "../agent-summary.js"
import type { NiriClient } from "../client.js"

export type AgentsViewProps = {
  client: NiriClient
  onChat: (id: string, label: string) => void
  onCreate: () => void
  onQuit: () => void
  /** Poll cadence for the background refresh; tests shorten it. */
  refreshMs?: number
}

/** What the list knows right now. Rows and failure are alternatives, never both. */
type Listing = { phase: "loading" } | { phase: "ready"; rows: AgentRow[] } | { phase: "offline"; error: string }

const toneColor: Record<Tone, string> = { ready: "green", error: "red", idle: "yellow" }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const cells = (widths: number[], values: string[]): string =>
  widths.map((width, index) => truncate(values[index] ?? "", width).padEnd(width)).join(" ")

/** Column budget for the terminal width: four columns when there is room, then three, then one. */
const layout = (width: number): number[] =>
  width < 54 ? [width - 6]
    : width >= 72 ? [Math.max(14, Math.floor(width * .28)), Math.max(10, Math.floor(width * .18)), Math.max(12, Math.floor(width * .31)), 8]
      : [Math.max(12, Math.floor(width * .4)), Math.max(10, Math.floor(width * .28)), Math.max(7, Math.floor(width * .18))]

const headings = ["agent", "status", "model", "rev"]
const rowValues = (row: AgentRow, narrow: boolean): string[] =>
  narrow ? [`${row.label} / ${row.status}`] : [row.label, row.status, row.model, row.revision]

export function AgentsView({ client, onChat, onCreate, onQuit, refreshMs = 5000 }: AgentsViewProps) {
  const [listing, setListing] = useState<Listing>({ phase: "loading" })
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const { columns, rows: height } = useWindowSize()
  const { write } = useStdout()

  // The list is a screen, not a log: entering it wipes whatever a chat left behind.
  useEffect(() => { write("\u001b[2J\u001b[H") }, [write])

  // One effect owns every load: mount, the 5s cadence, and the r key (via nonce).
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    const load = async (): Promise<void> => {
      try {
        const agents = await client.list(controller.signal)
        if (live) setListing({ phase: "ready", rows: agents.map(toRow) })
      } catch (error) {
        if (live && !controller.signal.aborted) setListing({ phase: "offline", error: message(error) })
      }
    }
    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [client, refreshMs, nonce])

  const rows = listing.phase === "ready" ? listing.rows : []
  const selected = Math.max(0, rows.findIndex((row) => row.id === selectedId))
  const move = (delta: number): void => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, selected + delta))]
    if (next) setSelectedId(next.id)
  }

  useInput((input, key) => {
    if (input === "q" || input === "Q" || (key.ctrl && input === "c")) return onQuit()
    if (input === "r" || input === "R") return setNonce((value) => value + 1)
    if (input === "c" || input === "C") return onCreate()
    if (key.upArrow || input === "k") return move(-1)
    if (key.downArrow || input === "j") return move(1)
    if (key.return && rows[selected]) onChat(rows[selected]!.id, rows[selected]!.label)
  })

  const width = Math.max(20, columns)
  const narrow = width < 54
  const widths = layout(width)
  // Header, url, blank, column heading, blank, hint.
  const available = Math.max(1, Math.max(8, height) - 6)
  const first = Math.min(Math.max(0, selected - available + 1), Math.max(0, rows.length - available))
  const hint = narrow
    ? "↑↓/j k select  enter chat  c create  r refresh  q exit"
    : "↑↓/j k select  enter chat  c create  r refresh  q exit  (/a or ← leaves chat)"

  return (
    <Box flexDirection="column">
      <Text><Text bold color="cyan">niri</Text><Text color="gray">  agents</Text></Text>
      <Text color="gray">{truncate(client.baseUrl, width)}</Text>
      <Text> </Text>
      {listing.phase === "loading" ? <Text color="gray">loading…</Text> : null}
      {listing.phase === "offline" ? (
        <>
          <Text><Text color="red">offline</Text> {truncate(listing.error, width - 9)}</Text>
          <Text color="gray">{truncate("no server? run `niri serve` to start one", width)}</Text>
          <Text> </Text>
          <Text color="gray">r refresh  q exit</Text>
        </>
      ) : null}
      {listing.phase === "ready" && !rows.length ? (
        <>
          <Text color="yellow">no agents yet</Text>
          <Text color="gray">{truncate("press c to create a stopped draft", width)}</Text>
          <Text> </Text>
          <Text color="gray">{truncate("c create  r refresh  q exit", width)}</Text>
        </>
      ) : null}
      {rows.length ? (
        <>
          <Text dimColor>{narrow ? "agent / status" : cells(widths, headings)}</Text>
          {rows.slice(first, first + available).map((row, offset) => {
            const index = first + offset
            return (
              <Text key={row.id} inverse={index === selected}>
                {index === selected ? "> " : "  "}
                <Text color={toneColor[row.tone]}>●</Text>
                {" "}
                {cells(widths, rowValues(row, narrow))}
              </Text>
            )
          })}
          <Text> </Text>
          <Text color="gray">{truncate(hint, width)}</Text>
        </>
      ) : null}
    </Box>
  )
}
