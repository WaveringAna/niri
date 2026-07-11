import readline from "readline"
import { createChatClient, type StreamEvent } from "@niri/chat-client"
import { renderMarkdownAnsi } from "./terminal-markdown"

const HOST = process.env.NIRI_HOST ?? "http://localhost"
const directWorker = process.env.NIRI_CHAT_DIRECT_WORKER?.trim().toLowerCase() === "true"
const controlAgentId = directWorker ? undefined : (process.env.NIRI_AGENT_ID ?? "niri").trim() || "niri"
const PORT = directWorker ? process.env.PORT ?? "3000" : process.env.CONTROL_PORT ?? process.env.PORT ?? "3000"
const BASE = process.env.NIRI_SERVER_URL?.replace(/\/+$/, "") || `${HOST}:${PORT}`
const token = directWorker ? process.env.NIRI_WORKER_TOKEN : process.env.NIRI_CONTROL_TOKEN

const c = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  cyanBright: (s: string) => `\x1b[96m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magentaBright: (s: string) => `\x1b[95m${s}\x1b[0m`,
}

const lineCount = (text: string): number => text.split("\n").length

const formatNumber = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)

const formatUsage = (event: Extract<StreamEvent, { type: "usage" }>): string => {
  const parts: string[] = []
  if (typeof event.tokensPerSecond === "number") parts.push(`${formatNumber(event.tokensPerSecond)} tok/s`)
  if (typeof event.completionTokens === "number") parts.push(`${event.completionTokens} out`)
  if (typeof event.promptTokens === "number") parts.push(`${event.promptTokens} ctx`)
  if (typeof event.totalTokens === "number") parts.push(`${event.totalTokens} total`)
  if (typeof event.elapsedMs === "number") parts.push(`${(event.elapsedMs / 1000).toFixed(1)}s`)
  return parts.length ? parts.join(" · ") : "usage unavailable"
}

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

const renderToolBody = (text: string): string =>
  text.includes("```") ? renderMarkdownAnsi(text) : renderMarkdownAnsi(`\`\`\`text\n${text}\n\`\`\``)

const createClientId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cli-${crypto.randomUUID()}`
  }
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const clientId = createClientId()
const client = createChatClient({ baseUrl: BASE, clientId, agentId: controlAgentId, token })

let showAllTools = false
let showThinking = false
let activeStreamKind: "text" | "thinking" | null = null
let activeStreamMuted = false
let activeStreamText = ""
let activeStreamRenderedLines = 0
let streamSettleTimer: ReturnType<typeof setTimeout> | null = null
let streamStatusCheckInFlight = false

const STREAM_SETTLE_CHECK_MS = 250

const isTerminal = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY)

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "")

const charCellWidth = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0
  }
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2
  }
  return 1
}

const visibleLineCount = (text: string): number => {
  const columns = Math.max(1, process.stdout.columns ?? 80)
  return stripAnsi(text)
    .split("\n")
    .reduce((rows, line) => {
      const width = Array.from(line).reduce((sum, char) => sum + charCellWidth(char), 0)
      return rows + Math.max(1, Math.ceil(width / columns))
    }, 0)
}

const repaintPrompt = () => {
  process.stdin.resume()
  rl.resume()
  rl.prompt(true)
}

const clearPromptLine = () => {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
}

const renderActiveStream = (): string | null => {
  if (!activeStreamKind) return null
  if (activeStreamKind === "text") return `${c.magentaBright("niri: ")}${activeStreamText}`
  if (activeStreamMuted) return c.gray("⟨ thinking ⟩")
  return c.gray(`⟨ thinking ⟩ ${activeStreamText}`)
}

const repaintActiveStream = () => {
  if (!isTerminal()) return

  clearPromptLine()
  if (activeStreamRenderedLines > 0) {
    readline.moveCursor(process.stdout, 0, -activeStreamRenderedLines)
  }
  readline.clearScreenDown(process.stdout)

  const rendered = renderActiveStream()
  if (rendered) {
    process.stdout.write(`${rendered}\n`)
    activeStreamRenderedLines = visibleLineCount(rendered)
  } else {
    activeStreamRenderedLines = 0
  }

  repaintPrompt()
}

const print = (line: string) => {
  endActiveStream()
  if (isTerminal()) {
    clearPromptLine()
    process.stdout.write(`${line}\n`)
    repaintPrompt()
    return
  }

  process.stdout.write(`${line}\n`)
}

const startActiveStream = (kind: "text" | "thinking") => {
  if (activeStreamKind === kind) return
  endActiveStream()

  activeStreamKind = kind
  activeStreamMuted = kind === "thinking" && !showThinking
  activeStreamText = ""

  if (isTerminal()) {
    repaintActiveStream()
    return
  }

  if (kind === "text") {
    process.stdout.write(c.magentaBright("niri: "))
  } else if (activeStreamMuted) {
    process.stdout.write(c.gray("⟨ thinking ⟩"))
  } else {
    process.stdout.write(c.gray("⟨ thinking ⟩ "))
  }
}

const appendActiveStream = (kind: "text" | "thinking", chunk: string) => {
  startActiveStream(kind)
  if (!chunk || activeStreamMuted) return

  if (isTerminal()) {
    activeStreamText += kind === "thinking" ? c.gray(chunk) : chunk
    repaintActiveStream()
    return
  }

  const rendered = kind === "thinking" ? c.gray(chunk) : chunk
  process.stdout.write(rendered)
}

function endActiveStream(): void {
  if (streamSettleTimer) {
    clearTimeout(streamSettleTimer)
    streamSettleTimer = null
  }

  if (!activeStreamKind) return

  if (!isTerminal()) process.stdout.write("\n")
  activeStreamKind = null
  activeStreamMuted = false
  activeStreamText = ""
  activeStreamRenderedLines = 0
  repaintPrompt()
}

const scheduleStreamSettleCheck = () => {
  if (streamSettleTimer) clearTimeout(streamSettleTimer)

  streamSettleTimer = setTimeout(async () => {
    if (!activeStreamKind || streamStatusCheckInFlight) return

    streamStatusCheckInFlight = true
    try {
      const status = await client.getStatus()
      if (!status.running || status.idle) {
        endActiveStream()
      } else {
        scheduleStreamSettleCheck()
      }
    } catch {
      scheduleStreamSettleCheck()
    } finally {
      streamStatusCheckInFlight = false
    }
  }, STREAM_SETTLE_CHECK_MS)
}

const handleStreamEvent = (event: StreamEvent) => {
  if (event.type === "thinking") {
    appendActiveStream("thinking", event.text)
    scheduleStreamSettleCheck()
    return
  }

  if (event.type === "tool") {
    endActiveStream()
    print(c.yellow(`tool: ${toolSummary(event.name, event.args)}`))
    if (showAllTools) {
      print(renderToolBody(event.result || "(no output)"))
    } else {
      print(c.gray(`… ${lineCount(event.result)} lines hidden · /v to expand`))
    }
    return
  }

  if (event.type === "user") {
    if (event.clientId === clientId) return
    endActiveStream()
    print(c.cyan(`${event.source}:`))
    print(renderMarkdownAnsi(event.text))
    return
  }

  if (event.type === "usage") {
    endActiveStream()
    print(c.gray(`stats: ${formatUsage(event)}`))
    return
  }

  appendActiveStream("text", event.text)
  scheduleStreamSettleCheck()
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: c.cyanBright("you: "),
  terminal: Boolean(process.stdin.isTTY),
})

print(c.gray("tips: /v toggle tool output · /t toggle thinking · /status · /q quit"))

client
  .getStatus()
  .then((status) => {
    print(c.gray(status.running ? "niri is awake" : "niri is sleeping — your message will wake her"))
  })
  .catch((err) => print(c.red(err instanceof Error ? err.message : String(err))))

const controller = new AbortController()
client
  .stream({ signal: controller.signal, onEvent: handleStreamEvent })
  .catch((err) => {
    if (controller.signal.aborted) return
    print(c.red(err instanceof Error ? err.message : String(err)))
  })

rl.prompt()

rl.on("line", async (line) => {
  const trimmed = line.trim()
  if (!trimmed) {
    rl.prompt()
    return
  }

  if (trimmed === "/q" || trimmed === "/quit" || trimmed === "/exit") {
    endActiveStream()
    controller.abort()
    rl.close()
    process.exit(0)
  }

  if (trimmed === "/status") {
    try {
      const status = await client.getStatus()
      print(c.gray(status.running ? "niri is awake" : "niri is sleeping — your message will wake her"))
    } catch (err) {
      print(c.red(err instanceof Error ? err.message : String(err)))
    }
    rl.prompt()
    return
  }

  if (trimmed === "/v" || trimmed === "/verbose") {
    showAllTools = !showAllTools
    print(c.gray(`tool output: ${showAllTools ? "expanded" : "collapsed"}`))
    rl.prompt()
    return
  }

  if (trimmed === "/t" || trimmed === "/thinking") {
    showThinking = !showThinking
    print(c.gray(`thinking traces: ${showThinking ? "visible" : "hidden"}`))
    rl.prompt()
    return
  }

  try {
    await client.send(trimmed)
  } catch (err) {
    print(c.red(err instanceof Error ? err.message : String(err)))
  }

  rl.prompt()
})

rl.on("SIGINT", () => {
  endActiveStream()
  controller.abort()
  rl.close()
  process.exit(0)
})

rl.on("close", () => {
  endActiveStream()
  controller.abort()
})
