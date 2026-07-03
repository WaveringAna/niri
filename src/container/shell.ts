import * as pty from "node-pty"
import { randomBytes } from "crypto"
import { spawn } from "child_process"
import {
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
} from "./config"
import type { RunRawOptions } from "./types"

function applyTerminalControls(str: string): string {
  let out = ""

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]

    if (ch === "\r") {
      if (str[i + 1] === "\n") {
        out += "\n"
        i += 1
      } else {
        const lineStart = out.lastIndexOf("\n") + 1
        out = out.slice(0, lineStart)
      }
      continue
    }

    if (ch === "\b" || ch === "\x7f") {
      if (out.length > 0 && out[out.length - 1] !== "\n") out = out.slice(0, -1)
      continue
    }

    if (ch === "\x00") continue
    out += ch
  }

  return out
}

/**
 * Strip ANSI/VT escape sequences and apply simple terminal line controls.
 * PTYs emit redraw-oriented output (CR, backspace, ANSI cursor commands) that
 * should not be preserved as literal command result text.
 */
export function cleanOutput(str: string): string {
  const withoutEscapes = str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colors, cursor, erase, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (title, etc.)
    .replace(/\x1b[^[\]]/g, "") // other 2-char ESC sequences
    .replace(/(?:\x03|\^C)\s*/g, "") // Ctrl+C echo after interrupt

  return applyTerminalControls(withoutEscapes)
}

function removeInternalPtyControlEchoes(str: string): string {
  return str
    .split("\n")
    .filter((line) => !/^(\+\s*)?stty -echo(?: 2> ?\/dev\/null)?$/.test(line))
    .join("\n")
}

function findSentinelOutput(str: string, sentinel: string, fromIndex = 0): { sentinelStart: number; nextLineStart: number } | null {
  let searchIndex = fromIndex

  while (searchIndex < str.length) {
    const idx = str.indexOf(sentinel, searchIndex)
    if (idx < 0) return null

    const lineStart = str.lastIndexOf("\n", idx - 1) + 1
    const lineEnd = str.indexOf("\n", idx + sentinel.length)
    const effectiveLineEnd = lineEnd < 0 ? str.length : lineEnd
    const prefix = str.slice(lineStart, idx)
    const suffix = str.slice(idx + sentinel.length, effectiveLineEnd)

    if (!/\b(?:echo|printf)\s+/.test(prefix) && suffix === "") {
      return {
        sentinelStart: idx,
        nextLineStart: lineEnd < 0 ? effectiveLineEnd : lineEnd + 1,
      }
    }

    searchIndex = idx + sentinel.length
  }

  return null
}

function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`
}

function removeInternalSentinelEchoes(str: string, sentinels: readonly string[]): string {
  return str
    .split("\n")
    .filter((line) => !sentinels.some((sentinel) => line.includes(sentinel)))
    .join("\n")
}

let bash: pty.IPty | null = null
const ECHO_DISABLE_SETTLE_MS = 25

function spawnBash(): { proc: pty.IPty; backend: string } {
  const env = {
    ...(process.env as Record<string, string>),
    // Commands run in a PTY, so Git otherwise assumes an interactive terminal
    // and may launch a pager for `log`, `show`, `diff`, etc. The pager blocks
    // the sentinel that marks command completion, causing tool-level timeouts.
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    LESS: "FRX",
  }
  const options = {
    name: "xterm-256color",
    cols: 220, // wide enough to avoid line-wrapping sentinels
    rows: 50,
    env,
  }

  if (USE_DOCKER_SHELL) {
    // docker exec -it allocates a PTY inside the container so bash runs
    // interactively with job control. Combined with node-pty on the host
    // this gives us a proper interactive shell where Ctrl+C interrupts
    // the running command rather than killing bash itself.
    return {
      proc: pty.spawn("docker", ["exec", "-it", "-u", CONTAINER_USER, CONTAINER_NAME, "bash"], options),
      backend: `docker:${CONTAINER_NAME}`,
    }
  }

  return {
    proc: pty.spawn("bash", ["--noprofile", "--norc", "-i"], {
      ...options,
      cwd: process.cwd(),
    }),
    backend: "local",
  }
}

/**
 * Opens and initializes the persistent PTY bash session inside the configured container.
 *
 * This performs one-time terminal setup (disable echo, normalize prompt, source bashrc)
 * so subsequent `runRaw` calls can rely on sentinel-based output capture.
 *
 * @returns A promise that resolves when the shell is ready for commands.
 * @throws If the container shell cannot be started or initialized.
 */
export async function openBash(): Promise<void> {
  if (bash) return

  const { proc, backend } = spawnBash()

  proc.onExit(({ exitCode }) => {
    console.log(`[bash:${backend}] exited with code ${exitCode}`)
    if (bash === proc) bash = null
  })

  bash = proc

  // Liveness check: if bash exits within 500ms the container is probably down.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500)
    const d = proc.onExit(() => {
      clearTimeout(timer)
      d.dispose()
      const detail = USE_DOCKER_SHELL ? ` — is the '${CONTAINER_NAME}' container running?` : ""
      reject(new Error(`bash exited immediately${detail}`))
    })
  })

  // We CANNOT use sentinel-based detection yet because bash echo is still on:
  // if sending `echo SENTINEL` bash will echo the line back before running it
  // so the sentinel appears in the output immediately as a false positive.
  //
  // Strategy: disable echo via a PROMPT-BASED signal.
  //   1. Send `stty -echo` without any unique token on that input line.
  //   2. Send `export PS1='<token>' PS2=''` and wait for the prompt token.
  //   3. Now echo is off meaning sentinel detection is safe for all subsequent calls.
  //   4. Use runRaw to source .bashrc and clear the prompt.

  const initToken = `NIRI_INIT_${randomBytes(4).toString("hex")}_`

  await new Promise<void>((resolve, reject) => {
    let buf = ""
    let dataDisposable: { dispose(): void } | null = null
    const timer = setTimeout(() => {
      dataDisposable?.dispose()
      reject(new Error("bash init timed out"))
    }, 10_000)
    dataDisposable = proc.onData((chunk: string) => {
      buf += chunk
      const clean = cleanOutput(buf)
      if (clean.includes(initToken)) {
        clearTimeout(timer)
        dataDisposable?.dispose()
        resolve()
      }
    })
    // Keep the token off the stty line. Otherwise the terminal echo can make
    // readiness detection fire before echo has actually been disabled.
    proc.write("stty -echo\n")
    setTimeout(() => {
      proc.write(`export PS1='${initToken}' PS2=''\n`)
    }, 25)
  })

  // Echo is now off. Clear the token prompt, source .bashrc, done.
  await runRaw("set +H; export PS1='' PS2=''")
  await runRaw("source ~/.bashrc 2>/dev/null || true; set +H; export PS1='' PS2=''")
  console.log(`[bash:${backend}] session ready`)
}

/**
 * Closes the active PTY shell session if one exists.
 */
export function closeBash(): void {
  if (bash) {
    bash.kill()
    bash = null
  }
}

export async function currentWorkingDirectory(timeoutMs?: number): Promise<string> {
  return (await runRaw("pwd -P", { timeoutMs, redirectStdinToDevNull: true })).trim()
}

/**
 * Runs a command in the persistent PTY session and returns cleaned output.
 *
 * This is the low-level primitive used by higher-level container tools.
 *
 * @param command - Raw shell command to execute.
 * @param options - Timeout and stdin-redirection behavior.
 * @returns Combined stdout/stderr output with PTY control noise removed.
 * @throws If command execution times out.
 */
export async function runRaw(command: string, options: RunRawOptions = {}): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  // Default: keep stdin attached to the PTY (used by internal heredoc-based
  // helpers that supply their own stdin). The model-facing runner (runCommand)
  // opts every command into /dev/null so interactive children cannot consume
  // the trailing completion sentinels buffered in the PTY.
  const redirectStdinToDevNull = options.redirectStdinToDevNull ?? false

  // Reconnect lazily if the session was lost.
  if (!bash) {
    console.log("[bash] no session — attempting to reconnect...")
    await openBash()
  }

  // Capture a stable local reference — the module-level `bash` may be nulled
  // by the exit handler while we're waiting for output.
  const session = bash!

  // Two sentinels: start + end. Any PTY output buffered from a previous
  // command arrives before the start sentinel and is discarded, preventing it
  // from being prepended to this command's output.
  const startSentinel = `__NIRI_START_${randomBytes(4).toString("hex")}__`
  const endSentinel = `__NIRI_DONE_${randomBytes(4).toString("hex")}__`
  let raw = ""
  let settled = false

  return new Promise((resolve, reject) => {
    let startWriteTimer: ReturnType<typeof setTimeout> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let commandWritten = false

    const writeCommandAndDoneSentinel = (): void => {
      if (commandWritten || settled) return
      commandWritten = true
      session.write(
        [
          groupedCommand,
          "stty -echo 2>/dev/null",
          // Keep unterminated command output from sharing a line with the done
          // sentinel. The captured body is trimEnd()'d, so this is not visible.
          `printf '\\n%s\\n' "$__niri_done"`,
          "",
        ].join("\n"),
      )
    }

    const dataDisposable = session.onData((chunk: string) => {
      raw += chunk
      const cleaned = cleanOutput(raw)
      const startLine = findSentinelOutput(cleaned, startSentinel)
      if (startLine) writeCommandAndDoneSentinel()
      const endLine = startLine ? findSentinelOutput(cleaned, endSentinel, startLine.nextLineStart) : null
      if (startLine && endLine) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (startWriteTimer) clearTimeout(startWriteTimer)
        dataDisposable.dispose()
        const body = cleaned.slice(startLine.nextLineStart, endLine.sentinelStart)
        resolve(removeInternalPtyControlEchoes(removeInternalSentinelEchoes(body, [startSentinel, endSentinel])).trimEnd())
      }
    })

    // Wrap command in a { } group. When requested, redirect stdin from
    // /dev/null so accidental interactive reads do not hang forever.
    // The closing } is on its own line so heredocs inside the command still
    // get their correct delimiter line.
    //
    // Re-assert `stty -echo` before both sentinels. Full-screen tools,
    // prompts, and some spinners can leave terminal echo enabled; if that
    // happens, bash echoes the sentinel input lines before executing them and
    // completion detection fires on our own command text.
    const groupedCommand = redirectStdinToDevNull ? `{ ${command}\n} < /dev/null` : `{ ${command}\n}`

    timer = setTimeout(() => {
      if (settled) return
      if (startWriteTimer) clearTimeout(startWriteTimer)
      // Phase 1: Interrupt the hanging command with Ctrl+C.
      // Some CLI tools (e.g. wispctl with TUI spinners) hang after completing
      // their work — they need a nudge to exit and let bash process the
      // remaining command group (including the end sentinel echo).
      session.write("\x03\n")

      // Phase 2: Grace period — give bash a moment to process the interrupt
      // and write the end sentinel. If sentinel appears during this window,
      // the data listener fires `resolve()` and clears this grace timer
      // (since it captures the `timer` variable binding, now reassigned).
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        if (startWriteTimer) clearTimeout(startWriteTimer)
        dataDisposable.dispose()
        // After a timeout + grace period we no longer know whether bash
        // consumed Ctrl+C, returned to a prompt, or still has a foreground
        // process attached. Reuse would interleave the next command with a
        // potentially poisoned PTY, so force a fresh session next time.
        session.kill()
        if (bash === session) bash = null
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
      }, 3_000)
    }, timeoutMs)

    // Send the echo-reset line separately. If a prior command left terminal
    // echo enabled, writing the whole wrapper at once can echo sentinel command
    // text into the PTY before `stty -echo` has executed.
    session.write("stty -echo 2>/dev/null\n")
    startWriteTimer = setTimeout(() => {
      if (settled) return
      session.write(
        [
          "set +H",
          `__niri_start=${shellQuote(startSentinel)}`,
          `__niri_done=${shellQuote(endSentinel)}`,
          `printf '%s\\n' "$__niri_start"`,
          "",
        ].join("\n"),
      )
    }, ECHO_DISABLE_SETTLE_MS)
  })
}

/**
 * Runs a command as a one-off child process instead of through the persistent
 * PTY shell. This follows Codex's shell-tool execution model for commands
 * that should not inherit interactive stdin, notably sudo.
 */
export async function runOneOff(command: string, cwd: string, options: RunRawOptions = {}): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  const args = USE_DOCKER_SHELL
    ? ["exec", "-i", "-u", CONTAINER_USER, "-w", cwd, CONTAINER_NAME, "bash", "-c", command]
    : ["-c", command]
  const program = USE_DOCKER_SHELL ? "docker" : "bash"

  return new Promise((resolve, reject) => {
    let raw = ""
    let settled = false
    const child = spawn(program, args, {
      cwd: USE_DOCKER_SHELL ? undefined : cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout.on("data", (chunk) => {
      raw += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      raw += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(cleanOutput(raw).trimEnd())
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}
