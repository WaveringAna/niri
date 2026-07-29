import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanOutput, closeBash } from "./shell.js"
import { configureNodeToolRuntime } from "./config.js"
import { runCommand } from "./tools.js"

test.afterEach(() => {
  closeBash()
})

test("shell disables git pager and terminal prompts", async () => {
  const output = await runCommand(
    "printf '%s\\n%s\\n%s\\n%s' \"$GIT_PAGER\" \"$GIT_TERMINAL_PROMPT\" \"$PAGER\" \"$LESS\"",
    0,
    5_000,
  )

  assert.equal(output, "cat\n0\ncat\nFRX")
})

test("shell recovers when a command leaves terminal echo enabled", async () => {
  // A full-screen tool re-enables echo on the controlling terminal — it does so
  // via /dev/tty, so it still affects the PTY even though the command's stdin is
  // redirected to /dev/null. The harness must restore -echo for the next call.
  assert.equal(await runCommand("stty echo < /dev/tty 2>/dev/null; echo first", 0, 5_000), "first")
  assert.equal(await runCommand("echo second", 0, 5_000), "second")
})

test("shell wrapper sentinels stay internal after terminal echo is re-enabled", async () => {
  await runCommand("stty echo < /dev/tty 2>/dev/null; printf 'echo-armed\\n'", 0, 5_000)

  const text = "thank you! it was really special to build something together with her ^.^"
  const quotedText = `'${text.replace(/'/g, "'\\''")}'`
  const output = await runCommand(`printf '%s\\n' ${quotedText}`, 0, 5_000)

  assert.equal(output, text)
  assert.doesNotMatch(output, /(?:echo\s+)?_*HARNESS_(?:START|DONE)_[0-9a-f]+_*/i)
})

test("shell wrapper does not echo sentinel setup into quoted command text", async () => {
  await runCommand("stty echo < /dev/tty 2>/dev/null; printf 'echo-armed\\n'", 0, 5_000)

  const text =
    "kira!! you have LAND now. your own name on your own piece of the internet, bought with your own fund and your community's trust."
  const quotedText = `'${text.replace(/'/g, "'\\''")}'`
  const output = await runCommand(`printf '%s\\n' ${quotedText}`, 0, 5_000)

  assert.equal(output, text)
  assert.doesNotMatch(output, /__harness_(?:start|done)/i)
  assert.doesNotMatch(output, /_*HARNESS_(?:START|DONE)_[0-9a-f]+_*/i)
})

test("shell preserves literal exclamation marks in interactive bash", async () => {
  const text = "aesop!! you're here!! mother approves of the reference render"
  const quotedText = `"${text.replace(/(["\\$`])/g, "\\$1")}"`
  const output = await runCommand(`printf '%s\\n' ${quotedText}`, 0, 5_000)

  assert.equal(output, text)
  assert.doesNotMatch(output, /printf '%s\\n'/)
  assert.doesNotMatch(output, /__harness_(?:start|done)/i)
  assert.doesNotMatch(output, /_*HARNESS_(?:START|DONE)_[0-9a-f]+_*/i)
})

test("shell wrapper sentinels stay internal when shell tracing is enabled", async () => {
  const output = await runCommand("set -x; echo traced", 0, 5_000)

  assert.match(output, /\btraced\b/)
  assert.doesNotMatch(output, /_*HARNESS_(?:START|DONE)_[0-9a-f]+_*/i)
})

test("shell wrapper source stays internal when Bash verbose mode is enabled", async () => {
  assert.equal(await runCommand("set -v; echo first", 0, 5_000), "first")
  assert.equal(await runCommand("echo second", 0, 5_000), "second")
})

test("commands without trailing newlines do not hide output behind completion sentinels", async () => {
  assert.equal(await runCommand("printf 'bare-output'", 0, 5_000), "bare-output")
  assert.equal(await runCommand("printf '%s' '12 34'", 0, 5_000), "12 34")
  assert.equal(await runCommand("printf '%s' 'literal printf output'", 0, 5_000), "literal printf output")
})

test("commands that read stdin do not consume completion sentinels", async () => {
  // Reproduces the interactive-prompt failure: a child that reads stdin until
  // EOF (like a clack prompt) would otherwise swallow the trailing sentinel
  // bytes buffered in the PTY and hang until timeout. With stdin redirected to
  // /dev/null it gets immediate EOF and the command completes normally.
  assert.equal(await runCommand("echo start; awk 'END { print \"end\" }'", 0, 5_000), "start\nend")
  // The session must still be usable afterward.
  assert.equal(await runCommand("echo ok", 0, 5_000), "ok")
})

test("shell rejects promptly when a command exits bash and reconnects", async () => {
  const startedAt = Date.now()
  await assert.rejects(runCommand("set -e; false", 0, 60_000), /bash exited during command with code 1/)
  assert.ok(Date.now() - startedAt < 5_000)
  assert.equal(await runCommand("echo recovered", 0, 5_000), "recovered")
})

test("cleanOutput collapses terminal redraw controls", () => {
  assert.equal(cleanOutput("one\rspinner\rdone\n"), "done\n")
  assert.equal(cleanOutput("abc\b \bd\n"), "abd\n")
  assert.equal(cleanOutput("\x1b[?25lhidden\x1b[?25h\n"), "hidden\n")
})

test("sudo commands run as one-off commands with stdin closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-fake-sudo-"))
  const fakeSudo = path.join(dir, "sudo")
  await fs.writeFile(
    fakeSudo,
    [
      "#!/bin/sh",
      "if [ -t 0 ]; then",
      "  echo stdin_tty",
      "else",
      "  echo stdin_not_tty",
      "fi",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  )

  const oldPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`
  configureNodeToolRuntime({ workspaceRoot: process.cwd(), shellEnvironment: { PATH: process.env.PATH } })
  try {
    const output = await runCommand("echo before; sudo printf ok; echo after", 0, 5_000)

    assert.equal(output, "before\nstdin_not_tty\nokafter")
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = oldPath
    }
    configureNodeToolRuntime({ workspaceRoot: process.cwd() })
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("runCommand truncates excessively long lines", async () => {
  const output = await runCommand("node -e \"console.log('a'.repeat(2010))\"", undefined, 5_000)
  assert.equal(output.length, 2000 + " ... [truncated line of 2010 characters]".length)
  assert.ok(output.endsWith(" ... [truncated line of 2010 characters]"))
})

test("shell capture aborts before unbounded output can exhaust memory", async () => {
  configureNodeToolRuntime({ workspaceRoot: process.cwd(), maxResultBytes: 1_000 })
  try {
    await assert.rejects(
      runCommand("node -e \"process.stdout.write('x'.repeat(1100000))\"", 0, 10_000),
      /output exceeded 1000000 bytes/,
    )
  } finally {
    closeBash()
    configureNodeToolRuntime({ workspaceRoot: process.cwd() })
  }
})
