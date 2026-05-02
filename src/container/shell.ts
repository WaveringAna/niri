import * as pty from "node-pty"
import { randomBytes } from "crypto"
import {
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
} from "./config.js"
import type { RunRawOptions } from "./types.js"

/**
 * Strip ANSI/VT escape sequences and normalize line endings from PTY output.
 * PTYs emit CRLF and control sequences that we don't want in command results.
 */
function cleanOutput(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI sequences (colors, cursor, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (title, etc.)
    .replace(/\x1b[^[\]]/g, "") // other 2-char ESC sequences
    .replace(/(?:\x03|\^C)\s*/g, "") // Ctrl+C echo after interrupt
    .replace(/\r\n/g, "\n") // CRLF -> LF
    .replace(/\r/g, "\n") // stray CR -> LF
    .replace(/\x00/g, "") // null bytes
}

let bash: pty.IPty | null = null

function spawnBash(): { proc: pty.IPty; backend: string } {
  const env = process.env as Record<string, string>
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
  await runRaw("export PS1='' PS2=''")
  await runRaw("source ~/.bashrc 2>/dev/null || true; export PS1='' PS2=''")
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
  // Default: keep stdin attached to the PTY for more natural command behavior.
  // Higher-level helpers (e.g. runCommand) can opt into /dev/null for commands
  // that are likely to block waiting for stdin.
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
    const dataDisposable = session.onData((chunk: string) => {
      raw += chunk
      const cleaned = cleanOutput(raw)
      if (cleaned.includes(startSentinel) && cleaned.includes(endSentinel)) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        dataDisposable.dispose()
        const start = cleaned.indexOf(startSentinel) + startSentinel.length
        const end = cleaned.indexOf(endSentinel)
        // Drop the single newline that echo adds after the start sentinel,
        // then trim trailing whitespace from the command output.
        resolve(cleaned.slice(start, end).replace(/^\n/, "").trimEnd())
      }
    })

    // Wrap command in a { } group. When requested, redirect stdin from
    // /dev/null so accidental interactive reads do not hang forever.
    // The closing } is on its own line so heredocs inside the command still
    // get their correct delimiter line.
    const groupedCommand = redirectStdinToDevNull ? `{ ${command}\n} < /dev/null` : `{ ${command}\n}`

    session.write(`echo ${startSentinel}\n${groupedCommand}\necho ${endSentinel}\n`)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dataDisposable.dispose()
      session.write("\x03\n")
      // After a timeout we no longer know whether bash consumed Ctrl+C,
      // returned to a prompt, or still has a foreground process attached.
      // Reuse would interleave the next command with a potentially poisoned
      // PTY, so force a fresh docker exec session next time.
      session.kill()
      if (bash === session) bash = null
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}
