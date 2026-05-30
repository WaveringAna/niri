import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanOutput, closeBash } from "./shell"
import { runCommand } from "./tools"

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

test("commands that read stdin do not consume completion sentinels", async () => {
  // Reproduces the interactive-prompt failure: a child that reads stdin until
  // EOF (like a clack prompt) would otherwise swallow the trailing sentinel
  // bytes buffered in the PTY and hang until timeout. With stdin redirected to
  // /dev/null it gets immediate EOF and the command completes normally.
  assert.equal(await runCommand("echo start; awk 'END { print \"end\" }'", 0, 5_000), "start\nend")
  // The session must still be usable afterward.
  assert.equal(await runCommand("echo ok", 0, 5_000), "ok")
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
  try {
    const output = await runCommand("echo before; sudo printf ok; echo after", 0, 5_000)

    assert.equal(output, "before\nstdin_not_tty\nokafter")
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = oldPath
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("runCommand truncates excessively long lines", async () => {
  const output = await runCommand("node -e \"console.log('a'.repeat(2010))\"", undefined, 5_000)
  assert.equal(output.length, 2000 + " ... [truncated line of 2010 characters]".length)
  assert.ok(output.endsWith(" ... [truncated line of 2010 characters]"))
})
