import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { closeBash } from "./shell"
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
