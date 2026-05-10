import readline from "readline"
import { createChatClient, type StreamEvent } from "@niri/chat-client"
import { renderMarkdownAnsi } from "./terminal-markdown"

const HOST = process.env.NIRI_HOST ?? "http://localhost"
const PORT = process.env.PORT ?? "4000"
const BASE = `${HOST}:${PORT}`

const c = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  cyanBright: (s: string) => `\x1b[96m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magentaBright: (s: string) => `\x1b[95m${s}\x1b[0m`,
}

const lineCount = (text: string): number => text.split("\n").length

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
const client = createChatClient({ baseUrl: BASE, clientId })

let showAllTools = false
let showThinking = false
let activeStreamKind: "text" | "thinking" | null = null
let activeStreamMuted = false
let streamSettleTimer: ReturnType<typeof setTimeout> | null = null
let streamStatusCheckInFlight = false

const STREAM_SETTLE_CHECK_MS = 250

const restorePrompt = () => {
  rl.resume()
  process.stdin.resume()
  rl.prompt()
}

const print = (line: string) => {
  endActiveStream()
  rl.pause()
  process.stdout.write(`\r\x1b[K${line}\n`)
  restorePrompt()
}

const startActiveStream = (kind: "text" | "thinking") => {
  if (activeStreamKind === kind) return
  endActiveStream()

  activeStreamKind = kind
  activeStreamMuted = kind === "thinking" && !showThinking

  rl.pause()
  process.stdout.write("\r\x1b[K")
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

  const rendered = kind === "thinking" ? c.gray(chunk) : chunk
  process.stdout.write(rendered)
}

function endActiveStream(): void {
  if (streamSettleTimer) {
    clearTimeout(streamSettleTimer)
    streamSettleTimer = null
  }

  if (!activeStreamKind) return

  process.stdout.write("\n")
  activeStreamKind = null
  activeStreamMuted = false
  restorePrompt()
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
