import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { __agentStateToolsTest } from "./agent-state-tools"

test("memory paths stay inside the agent memory directory", () => {
  assert.match(__agentStateToolsTest.memoryPath("people/ana.md"), /memories[/\\]people[/\\]ana\.md$/)
  assert.throws(() => __agentStateToolsTest.memoryPath("../escape.md"), /escapes/)
  assert.throws(() => __agentStateToolsTest.memoryPath("/tmp/escape.md"), /relative Markdown/)
  assert.throws(() => __agentStateToolsTest.memoryPath("notes.txt"), /relative Markdown/)
})

test("memory writes reject symlinked directories and files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-symlink-"))
  const home = path.join(root, "home")
  const outside = path.join(root, "outside")
  await fs.mkdir(path.join(home, "memories"), { recursive: true })
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(home, "memories", "linked-dir"))
  const outsideFile = path.join(outside, "outside.md")
  await fs.writeFile(outsideFile, "original")
  await fs.symlink(outsideFile, path.join(home, "memories", "linked-file.md"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    const { writeMemory } = await import(${JSON.stringify(moduleUrl)})
    for (const target of ["linked-dir/escaped.md", "linked-file.md"]) {
      let rejected = false
      try { await writeMemory(target, "changed", "append") } catch { rejected = true }
      if (!rejected) process.exit(2)
    }
  `
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  assert.equal(await fs.readFile(outsideFile, "utf8"), "original")
  await assert.rejects(() => fs.access(path.join(outside, "escaped.md")))
})
