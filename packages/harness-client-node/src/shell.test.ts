import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanOutput } from "./shell.js"
import { CLIENT_WORKSPACE_ROOT, configureNodeToolRuntime } from "./config.js"
import { runCommand } from "./tools.js"

test("shell disables git pager and terminal prompts", async () => {
  const output = await runCommand(
    "printf '%s\\n%s\\n%s\\n%s' \"$GIT_PAGER\" \"$GIT_TERMINAL_PROMPT\" \"$PAGER\" \"$LESS\"",
    0,
    5_000,
  )

  assert.equal(output, "cat\n0\ncat\nFRX")
})

test("shell calls do not inherit cwd or shell modes from earlier calls", async () => {
  const initial = await runCommand("pwd -P", 0, 5_000)
  assert.equal(await runCommand("cd / && pwd -P", 0, 5_000), "/")
  assert.equal(await runCommand("pwd -P", 0, 5_000), initial)

  const traced = await runCommand("set -x; echo traced-first", 0, 5_000)
  assert.match(traced, /traced-first/)
  const next = await runCommand("echo traced-second", 0, 5_000)
  assert.equal(next, "traced-second")
  assert.doesNotMatch(next, /__harness_(?:start|done)/i)
})

test("shell preserves literal exclamation marks", async () => {
  const text = "aesop!! you're here!! mother approves of the reference render"
  const quotedText = `"${text.replace(/(["\\$`])/g, "\\$1")}"`
  assert.equal(await runCommand(`printf '%s\\n' ${quotedText}`, 0, 5_000), text)
})

test("commands without trailing newlines keep their output", async () => {
  assert.equal(await runCommand("printf 'bare-output'", 0, 5_000), "bare-output")
  assert.equal(await runCommand("printf '%s' '12 34'", 0, 5_000), "12 34")
})

test("commands receive closed stdin and later calls remain usable", async () => {
  assert.equal(await runCommand("echo start; awk 'END { print \"end\" }'", 0, 5_000), "start\nend")
  assert.equal(await runCommand("set -e; false", 0, 5_000), "")
  assert.equal(await runCommand("echo recovered", 0, 5_000), "recovered")
})

test("cleanOutput collapses terminal redraw controls", () => {
  assert.equal(cleanOutput("one\rspinner\rdone\n"), "done\n")
  assert.equal(cleanOutput("abc\b \bd\n"), "abd\n")
  assert.equal(cleanOutput("\x1b[?25lhidden\x1b[?25h\n"), "hidden\n")
})

test("sudo commands run with stdin closed", async () => {
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
  const workspace = CLIENT_WORKSPACE_ROOT
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`
  configureNodeToolRuntime({ workspaceRoot: workspace, shellEnvironment: { PATH: process.env.PATH } })
  try {
    const output = await runCommand("echo before; sudo printf ok; echo after", 0, 5_000)
    assert.equal(output, "before\nstdin_not_tty\nokafter")
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    configureNodeToolRuntime({ workspaceRoot: workspace })
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("runCommand truncates excessively long lines", async () => {
  const output = await runCommand("node -e \"console.log('a'.repeat(2010))\"", undefined, 5_000)
  assert.equal(output.length, 2000 + " ... [truncated line of 2010 characters]".length)
  assert.ok(output.endsWith(" ... [truncated line of 2010 characters]"))
})

test("shell capture aborts before unbounded output can exhaust memory", async () => {
  const workspace = CLIENT_WORKSPACE_ROOT
  configureNodeToolRuntime({ workspaceRoot: workspace, maxResultBytes: 1_000 })
  try {
    await assert.rejects(
      runCommand("node -e \"console.log('x'.repeat(1100000))\"", 0, 10_000),
      /output exceeded 1000000 bytes/,
    )
  } finally {
    configureNodeToolRuntime({ workspaceRoot: workspace })
  }
})

test("shell timeout yields a resumable session without killing descendants", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-shell-yield-"))
  const marker = path.join(dir, "finished")
  try {
    const yielded = await runCommand({
      command: `(sleep 0.5; printf finished > '${marker}'; echo descendant-finished) & wait`,
      timeoutMs: 100,
      maxLines: 0,
    })
    const sessionId = yielded.match(/session (sh_[0-9a-f]+)/)?.[1]
    assert.ok(sessionId, yielded)
    assert.match(yielded, /still running/)

    const completed = await runCommand({ action: "poll", sessionId, timeoutMs: 2_000, maxLines: 0 })
    assert.match(completed, /descendant-finished/)
    assert.match(completed, /exited with code 0/)
    await assert.rejects(runCommand({ action: "poll", sessionId, timeoutMs: 100, maxLines: 0 }), /unknown shell session/)
    assert.equal(await fs.readFile(marker, "utf8"), "finished")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("shell sessions stop only after explicit termination", async () => {
  const yielded = await runCommand({ command: "sleep 30", timeoutMs: 100, maxLines: 0 })
  const sessionId = yielded.match(/session (sh_[0-9a-f]+)/)?.[1]
  assert.ok(sessionId, yielded)

  const terminated = await runCommand({ action: "terminate", sessionId, timeoutMs: 5_000, maxLines: 0 })
  assert.match(terminated, /terminated with signal SIGTERM/)
  await assert.rejects(runCommand({ action: "poll", sessionId, timeoutMs: 100, maxLines: 0 }), /unknown shell session/)
})
