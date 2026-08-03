import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const SUMMARY_HEADER = "[context summary v1]"
const SUMMARY_ID_RE = /^\[context-summary-id\s+(sum_[0-9a-f-]+)\]$/m
const DEFAULT_SERVICE = "niri-harness.service"
const DEFAULT_MAX_TRANSCRIPT_CHARS = 40_000
const RECOVERY_METHOD = "post-turn-llm-recovery"

type Options = {
  summaryId: string
  apply: boolean
  noRestart: boolean
  startService: boolean
  noAgentContext: boolean
  maxTranscriptChars: number
  service: string
  agentFile: string
  stateDir?: string
  backupDir?: string
  healthPorts: number[]
}

type Message = Record<string, unknown>
type DbRow = Record<string, unknown>

function usage(): void {
  console.log(`usage: recover-compaction.ts <summary-id> [options]

dry-run is the default. It calls the configured summarizer but does not stop the
service or write any state. Use --apply to perform the backup and recovery.

options:
  --apply                         stop, back up, repair, and restart the service
  --no-restart                    leave the service stopped after --apply
  --start-service                 start the service after --apply even if it was inactive
  --no-agent-context               omit soul/core/journal grounding from the summary prompt
  --max-transcript-chars <n>       summarizer transcript cap (default: ${DEFAULT_MAX_TRANSCRIPT_CHARS})
  --service <name>                systemd service (default: ${DEFAULT_SERVICE})
  --agent-file <path>             agent YAML (default: agents/niri.yaml)
  --state-dir <path>              state directory (default: $NIRI_HOME/state)
  --backup-dir <path>             explicit recovery backup directory
  --health-ports <ports>          comma-separated ports (default: 4000,4001,4002)
  --help                          show this help

The failed summary remains immutable in the archive. Recovery creates a new
summary node pointing at the failed node's last good parent and preserves the
current raw tail in session.json.`)
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseArgs(argv: string[]): Options | null {
  if (argv.length === 0 || argv.includes("--help")) {
    usage()
    return null
  }

  const first = argv[0]!
  if (!/^sum_[0-9a-f-]+$/.test(first)) throw new Error(`invalid summary id: ${first}`)
  const options: Options = {
    summaryId: first,
    apply: false,
    noRestart: false,
    startService: false,
    noAgentContext: false,
    maxTranscriptChars: DEFAULT_MAX_TRANSCRIPT_CHARS,
    service: DEFAULT_SERVICE,
    agentFile: "agents/niri.yaml",
    healthPorts: [4000, 4001, 4002],
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--apply") options.apply = true
    else if (arg === "--no-restart") options.noRestart = true
    else if (arg === "--start-service") options.startService = true
    else if (arg === "--no-agent-context") options.noAgentContext = true
    else if (arg === "--max-transcript-chars") options.maxTranscriptChars = parsePositiveInteger(argv[++index] ?? "", arg)
    else if (arg === "--service") options.service = argv[++index] ?? ""
    else if (arg === "--agent-file") options.agentFile = argv[++index] ?? ""
    else if (arg === "--state-dir") options.stateDir = argv[++index]
    else if (arg === "--backup-dir") options.backupDir = argv[++index]
    else if (arg === "--health-ports") {
      const raw = argv[++index] ?? ""
      options.healthPorts = raw.split(",").filter(Boolean).map((port) => parsePositiveInteger(port, "health port"))
    } else throw new Error(`unknown option: ${arg}`)
  }

  if (!options.service.trim()) throw new Error("service name cannot be empty")
  if (!options.agentFile.trim()) throw new Error("agent file cannot be empty")
  if (options.healthPorts.length === 0) throw new Error("at least one health port is required")
  return options
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCommand(command: string, args: string[], allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFile(command, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
    if (!allowFailure) {
      throw new Error(`${command} ${args.join(" ")} failed (${String(failure.code ?? "unknown")}): ${(failure.stderr || failure.stdout || failure.message || "").trim()}`)
    }
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

async function systemctl(options: Options, action: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("sudo", ["systemctl", action, options.service], action === "is-active")
}

async function serviceIsActive(options: Options): Promise<boolean> {
  const result = await systemctl(options, "is-active")
  return result.code === 0 && result.stdout.trim() === "active"
}

async function stopService(options: Options): Promise<void> {
  if (!(await serviceIsActive(options))) return
  console.log(`[recovery] stopping ${options.service}`)
  await systemctl(options, "stop")
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await serviceIsActive(options))) return
    await sleep(1_000)
  }
  throw new Error(`${options.service} did not stop within 60 seconds`)
}

async function startService(options: Options): Promise<void> {
  console.log(`[recovery] starting ${options.service}`)
  await systemctl(options, "start")
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await serviceIsActive(options)) return
    await sleep(1_000)
  }
  throw new Error(`${options.service} did not become active within 60 seconds`)
}

async function verifyHealth(ports: number[]): Promise<void> {
  for (const port of ports) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`health check failed on ${port}: HTTP ${response.status}`)
    console.log(`[recovery] health ${port}: HTTP ${response.status}`)
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  hash.update(await fs.readFile(filePath))
  return hash.digest("hex")
}

async function makeBackup(options: Options, agentHome: string, sourcePaths: string[], dbPath: string, targetId: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z")
  const backupDir = path.resolve(options.backupDir ?? path.join(agentHome, `compaction-recovery-${stamp}-${targetId.slice(4, 12)}`))
  if (backupDir === agentHome || backupDir.startsWith(`${agentHome}${path.sep}`) === false) {
    throw new Error(`backup directory must be inside the agent home: ${backupDir}`)
  }
  await fs.mkdir(backupDir)
  const manifest: string[] = []
  for (const sourcePath of sourcePaths) {
    if (!(await exists(sourcePath))) continue
    const destination = path.join(backupDir, path.basename(sourcePath))
    await fs.copyFile(sourcePath, destination)
    await fs.chmod(destination, 0o600)
    manifest.push(`${await sha256(destination)}  ${path.basename(destination)}`)
  }
  if (!manifest.some((line) => line.endsWith("  session.json"))) throw new Error("session.json was not backed up")
  if (!manifest.some((line) => line.endsWith(`  ${path.basename(dbPath)}`))) {
    throw new Error("niri.db was not backed up")
  }
  await fs.writeFile(path.join(backupDir, "SHA256SUMS"), `${manifest.join("\n")}\n`, { mode: 0o600 })
  console.log(`[recovery] backup: ${backupDir}`)
  for (const line of manifest) console.log(`[recovery] ${line}`)
  return backupDir
}

function canonicalMessage(message: Message): string {
  return JSON.stringify(message)
}

function summaryIdFromContent(content: string): string | null {
  return content.match(SUMMARY_ID_RE)?.[1] ?? null
}

function messageText(message: Message): string {
  return typeof message.content === "string" ? message.content : ""
}

function readDatabase(Database: any, dbPath: string): any {
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options) return

  const repoRoot = process.cwd()
  const agentFile = path.resolve(repoRoot, options.agentFile)
  const fileImport = (filePath: string): string => pathToFileURL(filePath).href
  const { parseAgentFile, agentSettings } = await import(fileImport(path.join(repoRoot, "packages/agent-config/src/index.ts")))
  const config = parseAgentFile(agentFile)
  const agentId = config.id ?? path.basename(agentFile).replace(/\.ya?ml$/i, "")
  const agentHome = path.resolve(repoRoot, config.home ?? path.join("data", "agents", agentId))
  const stateDir = path.resolve(options.stateDir ?? path.join(agentHome, "state"))
  const dbPath = path.join(agentHome, "niri.db")
  const sessionPath = path.join(stateDir, "session.json")
  const restSnapshotPath = path.join(stateDir, "rest-snapshot.json")

  Object.assign(process.env, agentSettings(config), {
    HOME: agentHome,
    NIRI_HOME: agentHome,
    NIRI_AGENT_ID: agentId,
    AGENT_NAME: config.name ?? agentId,
    NIRI_AGENT_STATE_DIR: stateDir,
    NIRI_MIGRATE_LEGACY_STATE: "false",
  })

  const util = await import(fileImport(path.join(repoRoot, "packages/niri-runtime/src/runner/util.ts")))
  const store = await import(fileImport(path.join(repoRoot, "packages/niri-runtime/src/runner/context-store.ts")))
  const runtimeDb = await import(fileImport(path.join(repoRoot, "packages/niri-runtime/src/db.ts")))
  const completion = await import(fileImport(path.join(repoRoot, "packages/niri-runtime/src/runner/loop-completion.ts")))
  const { createRequire } = await import("node:module")
  const Database = createRequire(path.join(repoRoot, "package.json"))("better-sqlite3")

  let wasActive = false
  let stopped = false
  let shouldRestart = false
  let backupDir: string | null = null
  try {
    if (options.apply) {
      wasActive = await serviceIsActive(options)
      shouldRestart = wasActive || options.startService
      await stopService(options)
      stopped = wasActive
      const sourcePaths = [sessionPath, restSnapshotPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      backupDir = await makeBackup(options, agentHome, sourcePaths, dbPath, options.summaryId)
    }

    const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as Message[]
    const summaryIndex = session.findIndex((message) => messageText(message).startsWith(SUMMARY_HEADER) && summaryIdFromContent(messageText(message)) === options.summaryId)
    if (summaryIndex < 0) throw new Error(`${options.summaryId} is not the active summary in ${sessionPath}`)

    const db = readDatabase(Database, dbPath)
    const target = db.prepare("select id, method, created_at, summary_text from context_summaries where id = ?").get(options.summaryId) as DbRow | undefined
    const parent = db.prepare("select p.parent_id, s.created_at, s.summary_text from context_summary_parents p join context_summaries s on s.id = p.parent_id where p.summary_id = ?").get(options.summaryId) as DbRow | undefined
    const directRows = db.prepare("select m.content_json from context_summary_messages sm join context_messages m on m.id = sm.message_id where sm.summary_id = ? order by sm.ordinal").all(options.summaryId) as Array<{ content_json: string }>
    const integrity = db.prepare("pragma integrity_check").get() as { integrity_check: string }
    db.close()
    if (!target) throw new Error(`${options.summaryId} is missing from context_summaries`)
    if (!parent) throw new Error(`${options.summaryId} has no parent summary; refusing to guess a replacement lineage`)
    if (integrity.integrity_check !== "ok") throw new Error(`SQLite integrity_check failed: ${integrity.integrity_check}`)
    if (directRows.length === 0) throw new Error(`${options.summaryId} has no direct archived source messages`)

    const directMessages = directRows.map((row) => JSON.parse(row.content_json) as Message)
    if (directMessages.some((message) => messageText(message).startsWith(SUMMARY_HEADER))) {
      throw new Error(`${options.summaryId} direct sources unexpectedly contain a summary wrapper`)
    }
    const parentContent = [
      SUMMARY_HEADER,
      "Compressed notes of older conversation turns. If anything conflicts, trust newer raw messages.",
      "[segments]",
      `[context-summary-id ${String(parent.parent_id)}]`,
      `[llm-summary ${String(parent.created_at)}]`,
      String(parent.summary_text),
    ].join("\n")
    const currentTail = session.slice(summaryIndex + 1)
    const originalInput = [...session.slice(0, summaryIndex), { role: "user", content: parentContent }, ...directMessages]
    const currentTailIds = new Set(currentTail.map(canonicalMessage))
    const sourceTailOverlap = directMessages.some((message) => currentTailIds.has(canonicalMessage(message)))
    if (sourceTailOverlap) throw new Error("archived compaction sources overlap the active tail; refusing an ambiguous splice")

    const provider = await completion.configuredSummaryProvider()
    if (!provider.client || !provider.model) throw new Error("no configured summary provider is available")
    console.log(`[recovery] target=${options.summaryId} parent=${String(parent.parent_id)} direct_sources=${directMessages.length}`)
    console.log(`[recovery] summarizing ${originalInput.length} preserved messages with ${provider.model}`)
    const compaction = await util.summarizeConversationViaLLMWithProvenance(originalInput, provider.client, provider.model, {
      recentMinKeep: 6,
      recentMaxKeep: 40,
      tailCharBudget: 60_000,
      maxTranscriptChars: options.maxTranscriptChars,
      agentContext: options.noAgentContext ? null : await util.loadAgentSummaryContext(),
    })
    if (!compaction) throw new Error("the built-in summarizer returned no usable compaction")
    const suspicious = [
      /the final output should be a summary/i,
      /the text you.re summarizing is the transcript itself/i,
      /- (?:assistant|user|tool):/i,
      /could you (?:share|provide|paste|send)/i,
      /i don.t see (?:any|the) (?:content|message|transcript)/i,
    ].filter((pattern) => pattern.test(compaction.summaryText))
    if (suspicious.length) throw new Error(`summary validation failed: ${suspicious.map(String).join(", ")}`)
    const beforeEstimate = util.estimatePromptTokens(originalInput)
    const afterEstimate = util.estimatePromptTokens(compaction.messages)
    if (afterEstimate >= beforeEstimate) throw new Error(`summary is not smaller (${beforeEstimate} -> ${afterEstimate} estimated tokens)`)
    console.log(`[recovery] candidate summary chars=${compaction.summaryText.length} messages=${compaction.messages.length} compacted=${compaction.compactedMessages.length}`)

    if (!options.apply) {
      console.log("[recovery] dry-run only; no files, database rows, or services were changed")
      return
    }

    runtimeDb.initDb()
    const newSummaryId = store.recordContextCompaction({
      summaryText: compaction.summaryText,
      compactedMessages: compaction.compactedMessages,
      priorSummaryContent: parentContent,
      method: RECOVERY_METHOD,
    })
    const repairedCore = store.attachContextSummaryId(compaction.messages, newSummaryId) as Message[]
    const generatedSummaryIndex = repairedCore.findIndex((message) => messageText(message).startsWith(SUMMARY_HEADER))
    if (generatedSummaryIndex < 0) throw new Error("new summary id could not be attached to the repaired context")
    const generatedTail = repairedCore.slice(generatedSummaryIndex + 1)
    const generatedTailIds = new Set(generatedTail.map(canonicalMessage))
    if (currentTail.some((message) => generatedTailIds.has(canonicalMessage(message)))) {
      throw new Error("generated summary tail overlaps the active tail; refusing to duplicate messages")
    }
    const repaired = [...repairedCore, ...currentTail]
    await util.saveSession(repaired)
    await util.saveRestSnapshot(repaired, "runtime checkpoint after compaction recovery")
    if (backupDir) {
      await fs.writeFile(path.join(backupDir, "recovery-result.json"), JSON.stringify({
        oldSummaryId: options.summaryId,
        newSummaryId,
        parentSummaryId: parent.parent_id,
        method: RECOVERY_METHOD,
        summaryChars: compaction.summaryText.length,
        sourceMessages: compaction.compactedMessages.length,
        activeMessages: repaired.length,
        summaryText: compaction.summaryText,
      }, null, 2), { mode: 0o600 })
    }

    const finalSession = JSON.parse(await fs.readFile(sessionPath, "utf8")) as Message[]
    const finalRest = JSON.parse(await fs.readFile(restSnapshotPath, "utf8")) as { forest: string }
    const finalActive = finalSession.find((message) => messageText(message).startsWith(SUMMARY_HEADER))
    const finalId = finalActive ? summaryIdFromContent(messageText(finalActive)) : null
    const verifyDb = readDatabase(Database, dbPath)
    const finalIntegrity = (verifyDb.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check
    verifyDb.close()
    if (finalId !== newSummaryId || messageText(finalActive ?? {}).includes(options.summaryId) || finalRest.forest.includes(options.summaryId) || finalIntegrity !== "ok") {
      throw new Error("post-write verification failed; recovery backup was preserved")
    }
    console.log(`[recovery] wrote new summary ${newSummaryId}; old node preserved as immutable archive history`)
    console.log(`[recovery] verified session=${finalSession.length} messages sqlite_integrity=${finalIntegrity}`)
  } catch (error) {
    if (options.apply && shouldRestart && stopped && !(await serviceIsActive(options))) {
      console.error("[recovery] repair failed; restarting the service from the preserved backup state")
      await startService(options).catch((restartError) => console.error(`[recovery] restart after failure also failed: ${String(restartError)}`))
    }
    throw error
  }

  if (options.apply && shouldRestart && !options.noRestart) {
    await startService(options)
    await verifyHealth(options.healthPorts)
  } else if (options.apply && stopped) {
    console.log(`[recovery] ${options.service} remains stopped (--no-restart)`)
  }
}

main().catch((error) => {
  console.error(`[recovery] ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
