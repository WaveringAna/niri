import { createElement, type ReactElement } from "react"
import { Command, CommanderError, type OptionValues } from "commander"
import { formatAgentList } from "./agent-summary.js"
import { HttpError, NiriClient, localOperatorToken, type AgentConfig } from "./client.js"
import { loadConfigDocument, loadSeed } from "./seed.js"
import { creationHints } from "./creation-hints.js"
import { serveLogs, serveStart, serveStatus, serveStop, type ServeDeps } from "./serve.js"

type Writer = Pick<NodeJS.WriteStream, "write">
export type CliDependencies = { fetchImpl?: typeof fetch; stdout?: Writer; stderr?: Writer; isTty?: boolean; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; serveDeps?: ServeDeps }
export type CliResult = { code: number }

const write = (stream: Writer, value: unknown, jsonMode: boolean): void => {
  const rendered = typeof value === "string" && !jsonMode ? value : JSON.stringify(value, null, 2)
  stream.write(`${rendered ?? ""}\n`)
}
const parseValue = (value: string): unknown => { try { return JSON.parse(value) as unknown } catch { return value } }
const nested = (pathName: string, value: unknown): AgentConfig => {
  const keys = pathName.split(".").map((part) => part.trim()).filter(Boolean)
  if (!keys.length) throw new Error("config path is required")
  return keys.reduceRight<AgentConfig>((acc, key) => ({ [key]: acc }), value as AgentConfig)
}
const unavailable = (error: unknown): boolean => error instanceof HttpError && error.status === 404

/** Connection flags are accepted on every command, matching the hand-rolled parser they replace. */
const connectionOptions = (command: Command): Command =>
  command
    .option("--server <url>", "control server URL (default NIRI_SERVER_URL or http://127.0.0.1:3000)")
    .option("--url <url>", "alias for --server")
    .option("--token <token>", "operator bearer token (default NIRI_TOKEN, or the local admin.token file)")
    .option("--json", "machine-readable output")

export async function main(argv: string[], dependencies: CliDependencies = {}): Promise<CliResult> {
  const stdout = dependencies.stdout ?? process.stdout; const stderr = dependencies.stderr ?? process.stderr

  // Resolved lazily so `--help` and parse errors never touch the filesystem or network.
  let connected: { client: NiriClient; token?: string; jsonMode: boolean } | undefined
  const context = async (options: OptionValues) => {
    if (connected) return connected
    const serverUrl = String(options.server ?? options.url ?? process.env.NIRI_SERVER_URL ?? "http://127.0.0.1:3000")
    const token = options.token ? String(options.token).trim() : await localOperatorToken(serverUrl) ?? process.env.NIRI_TOKEN?.trim()
    connected = { client: new NiriClient({ baseUrl: serverUrl, token, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) }), token, jsonMode: options.json === true }
    return connected
  }
  const print = (options: OptionValues) => (value: unknown): void => write(stdout, value, options.json === true)
  const tty = (): boolean => dependencies.isTty !== false && (dependencies.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))

  /**
   * Every interactive screen is one Ink app that owns stdin, stdout and raw
   * mode for its whole life. `leave` unmounts it, so a standalone screen can
   * end the command from inside the render tree.
   */
  const renderInk = async (build: (leave: () => void) => ReactElement, exitOnCtrlC = true): Promise<void> => {
    const { render } = await import("ink")
    let leave = (): void => {}
    const app = render(build(() => leave()), { stdin: dependencies.input ?? process.stdin, stdout: dependencies.output ?? process.stdout, exitOnCtrlC })
    leave = app.unmount
    await app.waitUntilExit()
  }

  const program = new Command()
  program
    .name("niri")
    .description("niri — control-plane client. bare niri opens the agents view on a terminal; seeds accept JSON, YAML, or .nix via nix eval.")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: (text) => stdout.write(text), writeErr: (text) => stderr.write(text) })
  connectionOptions(program)

  program.action(async (_args: string[], command: Command) => {
    const options = { ...command.optsWithGlobals() }
    const { client, jsonMode } = await context(options)
    if (!jsonMode && tty()) {
      const { RootApp } = await import("./ui/app.js")
      // Ctrl-C belongs to the screen that owns it: it quits the list and a chat,
      // and only cancels a half-finished draft back to the list.
      await renderInk(() => createElement(RootApp, { client, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) }), false)
      return
    }
    const agents = await client.list()
    if (jsonMode) print(options)({ agents })
    else stdout.write(`${formatAgentList(agents)}${agents.length ? "\n" : ""}`)
  })

  program.command("server").description("print the control server URL in use")
    .action(async (_args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      print(options)({ url: client.baseUrl })
    })

  program.command("operator").description("operator credential helpers")
    .command("token").description("print the operator token in use")
    .action(async (_args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { token } = await context(options)
      if (!token) throw new Error("no operator token found; set --token or NIRI_TOKEN")
      print(options)(token)
    })

  const serve = program.command("serve").description("run the control server as a daemon (stop | restart | status | logs)")
  connectionOptions(serve)
    .argument("[action]", "start | stop | restart | status | logs", "start")
    .option("--port <n>", "control port (default 3000)")
    .option("--host <host>", "loopback or wildcard bind (default 127.0.0.1)")
    .option("--agents <dir>", "seed directory to import")
    .option("--lines <n>", "log lines to show", "20")
    .action(async (action: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const deps = dependencies.serveDeps ?? {}
      const launch = async (): Promise<void> => {
        const port = Number(options.port ?? "3000")
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535")
        const host = String(options.host ?? "127.0.0.1").trim() || "127.0.0.1"
        const agentsDirectory = options.agents ? String(options.agents).trim() : undefined
        const started = await serveStart({ port, host, ...(agentsDirectory ? { agentsDirectory } : {}), ...deps })
        if (options.json === true) print(options)({ status: "running", url: started.url, pid: started.pid, log: started.logFile })
        else stdout.write(`niri serving at ${started.url} (pid ${started.pid})\nlogs: ${started.logFile} — niri serve stop | status | logs\n`)
      }
      if (action === "start") return launch()
      if (action === "restart") { await serveStop(deps); return launch() }
      if (action === "stop") {
        const stopped = await serveStop(deps)
        return print(options)(stopped.stopped ? { status: "stopped", pid: stopped.pid, url: stopped.url } : { status: "not running", ...(stopped.pid ? { stalePid: stopped.pid, url: stopped.url } : {}) })
      }
      if (action === "status") return print(options)(await serveStatus(deps))
      if (action === "logs" || action === "log") { stdout.write(`${serveLogs(Number(options.lines ?? "20"), deps)}\n`); return }
      throw new Error("unknown serve command; run niri help")
    })

  const agents = program.command("agents").description("agent lifecycle")
  connectionOptions(agents)
  agents.command("list", { isDefault: true }).description("list configured agents").action(async (_args: string[], command: Command) => {
    const options = command.optsWithGlobals()
    const { client } = await context(options)
    const list = await client.list()
    print(options)(options.json === true ? { agents: list } : `${formatAgentList(list)}${list.length ? "\n" : ""}`)
  })
  agents.command("create <id>").description("create a stopped agent; prompts for model and discord when interactive")
    .option("--config <file>", "seed the new agent from a YAML/JSON/nix file")
    .option("--from <file>", "alias for --config")
    .option("--start", "start the agent immediately")
    .action(async (id: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      const file = options.config ?? options.from
      if (!file && tty()) {
        const { CreateFlow } = await import("./ui/create.js")
        await renderInk((leave) => createElement(CreateFlow, { client, id, start: options.start === true, onDone: leave }))
        return
      }
      const config = file ? await loadConfigDocument(String(file)) : undefined
      const created = await client.create(id, config, options.start === true, Boolean(file))
      print(options)(created)
      const model = (created as { config?: { model?: { name?: unknown } } }).config?.model
      stdout.write(creationHints(id, Boolean(model && typeof model.name === "string" && model.name)))
    })
  for (const action of ["start", "stop", "restart"] as const) {
    agents.command(`${action} <id>`).description(`${action} an agent`).action(async (id: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      print(options)(await client.lifecycle(id, action))
    })
  }

  program.command("chat").description("chat with an agent").argument("[id]", "agent id")
    .action(async (id: string | undefined, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client, token } = await context(options)
      if (!tty()) throw new Error("niri chat needs a terminal; run it from an interactive shell, or drive the agent with niri config / niri agents")
      const { ChatScreen } = await import("./ui/chat.js")
      // One leave function for both exits: a standalone chat has no agents view to return to.
      await renderInk((leave) => createElement(ChatScreen, {
        baseUrl: client.baseUrl, ...(token ? { token } : {}), agentId: id ?? "niri",
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}), onBack: leave, onQuit: leave,
      }))
    })

  const config = program.command("config").description("read and write durable agent config")
  connectionOptions(config)
    .option("--reason <reason>", "audit note recorded with a mutation")
  config.command("show <id>").description("print an agent's saved config").action(async (id: string, _args: string[], command: Command) => {
    const options = command.optsWithGlobals()
    const { client } = await context(options)
    print(options)(await client.getConfig(id))
  })
  config.command("set <id> <path> <value...>").description("set one config path (objects merge, arrays replace)")
    .action(async (id: string, pathName: string, value: string[], _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      const joined = value.join(" ").trim()
      if (!pathName || !joined) throw new Error("usage: niri config set ID PATH VALUE")
      print(options)(await client.patch(id, nested(pathName, parseValue(joined)), options.reason ? String(options.reason) : undefined))
    })
  config.command("apply <id> <file>").description("three-way apply a seed file onto an agent's config")
    .action(async (id: string, file: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      print(options)(await client.seed(id, await loadConfigDocument(file), options.reason ? String(options.reason) : undefined))
    })
  config.command("diff <id> <file>").description("preview a seed apply without writing").action(async (id: string, file: string, _args: string[], command: Command) => {
    const options = command.optsWithGlobals()
    const { client } = await context(options)
    print(options)(await client.diff(id, await loadConfigDocument(file)))
  })
  config.command("history <id>").description("revision history with actors and reasons").action(async (id: string, _args: string[], command: Command) => {
    const options = command.optsWithGlobals()
    const { client } = await context(options)
    print(options)(await client.history(id))
  })
  config.command("rollback <id> <revision>").description("restore a previous revision as a new one")
    .action(async (id: string, revision: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      const parsed = Number(revision)
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("revision must be a positive integer")
      print(options)(await client.rollback(id, parsed, options.reason ? String(options.reason) : undefined))
    })

  program.command("seed").description("create agents from seed files; JSON, YAML, or .nix")
    .argument("<file>", "seed document (single agent, { agents: [...] }, or a nix file)")
    .option("--overwrite", "reapply seeds that already exist (three-way merge)")
    .option("--apply", "alias for --overwrite")
    .option("--reapply", "alias for --overwrite")
    .action(async (file: string, _args: string[], command: Command) => {
      const options = command.optsWithGlobals()
      const { client } = await context(options)
      const reapplyRequested = options.overwrite === true || options.apply === true || options.reapply === true
      const results: unknown[] = []
      for (const seed of await loadSeed(file)) {
        try {
          const current = await client.getConfig(seed.id)
          if (!reapplyRequested) { results.push({ id: seed.id, action: "skipped", revision: current.revision }); continue }
          results.push(await client.seed(seed.id, seed.config, "seed overwrite"))
        } catch (error) {
          if (!unavailable(error)) throw error
          results.push(await client.create(seed.id, seed.config, seed.start === true, true))
        }
      }
      print(options)(options.json === true ? { seeds: results } : results.map((result) => JSON.stringify(result)).join("\n"))
    })

  try {
    await program.parseAsync(argv, { from: "user" })
    return { code: 0 }
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander already wrote help or the error through configureOutput.
      return { code: error.code === "commander.helpDisplayed" || error.code === "commander.version" ? 0 : 1 }
    }
    stderr.write(`niri: ${error instanceof Error ? error.message : String(error)}\n`)
    return { code: 1 }
  }
}
