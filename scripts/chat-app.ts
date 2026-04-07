import readline from "readline"
import { createChatClient, type StreamEvent } from "@niri/chat-client"
import { renderMarkdownAnsi } from "./terminal-markdown.js"

const HOST = process.env.NIRI_HOST ?? "http://localhost"
const PORT = process.env.PORT ?? "3000"
const BASE = `${HOST}:${PORT}`

const WRAP_UP_MESSAGE = "hey, wrapping up for now. please journal this session and rest 💙"

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

export function runChat() {
  const clientId = createClientId()
  const client = createChatClient({ baseUrl: BASE, clientId })

  let showAllTools = false
  let showThinking = false
  let shuttingDown = false

  const print = (line: string) => {
    rl.pause()
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.resume()
    rl.prompt(true)
  }

  const handleStreamEvent = (event: StreamEvent) => {
    if (event.type === "thinking") {
      if (showThinking) {
        print(c.gray("⟨ thinking ⟩"))
        print(renderMarkdownAnsi(event.text))
      } else {
        print(c.gray(`⟨ thinking — ${lineCount(event.text)} lines ⟩`))
      }
      return
    }

    if (event.type === "tool") {
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
      print(c.cyan(`${event.source}:`))
      print(renderMarkdownAnsi(event.text))
      return
    }

    print(c.magentaBright("niri:"))
    print(renderMarkdownAnsi(event.text))

    if (shuttingDown) {
      print(c.gray("— goodbye —"))
      rl.close()
      process.exit(0)
    }
  }

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    print(c.gray("asking niri to journal and rest…"))

    const timeout = setTimeout(() => {
      print(c.gray("— no response, goodbye —"))
      rl.close()
      process.exit(0)
    }, 30_000)
    timeout.unref()

    try {
      await client.send(WRAP_UP_MESSAGE)
    } catch (err) {
      print(c.red(err instanceof Error ? err.message : String(err)))
      rl.close()
      process.exit(1)
    }
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

    print(c.cyanBright(`you: ${trimmed}`))

    try {
      await client.send(trimmed)
    } catch (err) {
      print(c.red(err instanceof Error ? err.message : String(err)))
    }

    rl.prompt()
  })

  rl.on("SIGINT", () => {
    void shutdown()
  })

  rl.on("close", () => {
    controller.abort()
  })
}
