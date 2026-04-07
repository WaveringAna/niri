import * as pty from "node-pty"
import { randomBytes } from "crypto"
import {
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
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
    .replace(/\^C\s*/g, "") // Ctrl+C echo after interrupt
    .replace(/\r\n/g, "\n") // CRLF -> LF
    .replace(/\r/g, "\n") // stray CR -> LF
    .replace(/\x00/g, "") // null bytes
}

let bash: pty.IPty | null = null

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
  // docker exec -it allocates a PTY inside the container so bash runs
  // interactively with job control. Combined with node-pty on the host
  // this gives us a proper interactive shell where Ctrl+C interrupts
  // the running command rather than killing bash itself.
  const proc = pty.spawn("docker", ["exec", "-it", "-u", CONTAINER_USER, CONTAINER_NAME, "bash"], {
    name: "xterm-256color",
    cols: 220, // wide enough to avoid line-wrapping sentinels
    rows: 50,
    env: process.env as Record<string, string>,
  })

  proc.onExit(({ exitCode }) => {
    console.log(`[bash] exited with code ${exitCode}`)
    if (bash === proc) bash = null
  })

  bash = proc

  // Liveness check: if bash exits within 500ms the container is probably down.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500)
    const d = proc.onExit(() => {
      clearTimeout(timer)
      d.dispose()
      reject(new Error(`bash exited immediately — is the '${CONTAINER_NAME}' container running?`))
    })
  })

  // We CANNOT use sentinel-based detection yet because bash echo is still on:
  // if sending `echo SENTINEL` bash will echo the line back before running it
  // so the sentinel appears in the output immediately as a false positive.
  //
  // Strategy: disable echo via a PROMPT-BASED signal.
  //   1. Send `stty -echo; export PS1='<token>' PS2=''`
  //   2. Wait for <token> to appear in the PTY output
  //   3. Now echo is off meaning sentinel detection is safe for all subsequent calls.
  //   4. Use runRaw to source .bashrc and clear the prompt.

  const initToken = `NIRI_INIT_${randomBytes(4).toString("hex")}_`

  await new Promise<void>((resolve, reject) => {
    let buf = ""
    const d = proc.onData((chunk: string) => {
      buf += chunk
      const clean = cleanOutput(buf)
      if (clean.includes(initToken)) {
        d.dispose()
        resolve()
      }
    })
    // stty runs directly on the PTY (no stdin redirect); this is intentional.
    proc.write(`stty -echo; export PS1='${initToken}' PS2=''\n`)
    setTimeout(() => {
      d.dispose()
      reject(new Error("bash init timed out"))
    }, 10_000)
  })

  // Echo is now off. Clear the token prompt, source .bashrc, done.
  await runRaw("export PS1='' PS2=''")
  await runRaw("source ~/.bashrc 2>/dev/null || true; export PS1='' PS2=''")
  console.log("[bash] session ready")
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
  const redirectStdinToDevNull = options.redirectStdinToDevNull ?? true

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
        resolve(cleaned.slice(start).replace(/^\n/, "").slice(0, end - start).trimEnd())
      }
    })

    // Wrap command in a { } group. By default we redirect stdin from /dev/null
    // so accidental interactive reads do not hang forever.
    // The closing } is on its own line so heredocs inside the command still
    // get their correct delimiter line.
    const groupedCommand = redirectStdinToDevNull ? `{ ${command}\n} < /dev/null` : `{ ${command}\n}`

    session.write(`echo ${startSentinel}\n${groupedCommand}\necho ${endSentinel}\n`)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dataDisposable.dispose()
      session.write("\x03\n")
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}
