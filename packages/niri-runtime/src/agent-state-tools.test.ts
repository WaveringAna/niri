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

test("memory patch mode edits successfully and enforces unique target presence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-patch-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  
  const testFile = path.join(memoriesDir, "journal.md")
  await fs.writeFile(testFile, "# Journal\n\n## today\n\nsome text\n\n## today\n\nother text\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { writeMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Success case
    const res = await writeMemory("journal.md", "some new text", "patch", "some text")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => writeMemory("journal.md", "new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => writeMemory("journal.md", "new", "patch", "## today"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  const finalContent = await fs.readFile(testFile, "utf8")
  assert.equal(finalContent, "# Journal\n\n## today\n\nsome new text\n\n## today\n\nother text\n")
})

test("soul patch mode edits successfully and enforces unique target presence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-soul-patch-"))
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  
  const testFile = path.join(home, "soul.md")
  await fs.writeFile(testFile, "I am an agent named Niri.\nI am very smart.\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { writeSoul } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Success case
    const res = await writeSoul("an advanced coder.", "patch", "an agent named Niri.")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => writeSoul("new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => writeSoul("new", "patch", "I am"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  const finalContent = await fs.readFile(testFile, "utf8")
  assert.equal(finalContent, "I am an advanced coder.\nI am very smart.\n")
})

test("memory read and list tools function correctly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-read-ls-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })

  await fs.writeFile(path.join(memoriesDir, "core.md"), "Core fact 1\nCore fact 2\n", "utf8")
  await fs.mkdir(path.join(memoriesDir, "journal"), { recursive: true })
  await fs.writeFile(path.join(memoriesDir, "journal", "2026-07-12.md"), "Line 1\nLine 2\nLine 3\n", "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "sectioned.md"), "# Sec 1\nContent 1\n## Sec 2\nContent 2\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { readMemory, listMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Test listMemory
    const filesList = await listMemory()
    assert.equal(filesList, "core.md\\njournal/2026-07-12.md\\njournal/sectioned.md")
    
    // 2. Test readMemory whole file
    const contentAll = await readMemory("journal/2026-07-12.md")
    assert.match(contentAll, /Line 1\\nLine 2\\nLine 3/)
    
    // 3. Test readMemory line ranges
    const contentRange = await readMemory("journal/2026-07-12.md", 2, 3)
    assert.match(contentRange, /Line 2\\nLine 3/)
    assert.doesNotMatch(contentRange, /Line 1/)
    
    // 4. Test readMemory non-existent file
    await assert.rejects(() => readMemory("missing.md"))
    
    // 5. Test header stopping logic
    const sec1 = await readMemory("journal/sectioned.md", 1)
    assert.match(sec1, /Sec 1\\nContent 1/)
    assert.doesNotMatch(sec1, /Sec 2/)
    
    // 6. Test that range checks continue past endLine to the next header (e.g. read 1-1 continues to 2)
    const extendedSec = await readMemory("journal/sectioned.md", 1, 1)
    assert.match(extendedSec, /Sec 1\\nContent 1/)
    assert.doesNotMatch(extendedSec, /Sec 2/)
    
    // 7. Test reading all sections by passing endLine past the last header
    const bothSecs = await readMemory("journal/sectioned.md", 1, 4)
    assert.match(bothSecs, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})

test("memory and soul validation, warning, and backup operations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-ext-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    const { writeSoul, writeMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Test Markdown Validation (broken header)
    await assert.rejects(
      () => writeSoul("##Header without space", "append"),
      /Markdown validation failed/
    )
    
    // 2. Test Markdown Validation (unclosed code blocks)
    await assert.rejects(
      () => writeSoul("some text\\n\`\`\`\\ncode block", "append"),
      /Markdown validation failed/
    )
    
    // 3. Test soul.md and core.md rolling backup (.bak) creation
    await writeSoul("# Valid Soul", "append")
    await writeSoul("# Updated Soul", "patch", "# Valid Soul")
    const soulBakExists = await fs.stat(path.join(${JSON.stringify(home)}, "soul.md.bak")).then(() => true).catch(() => false)
    assert.equal(soulBakExists, true)

    await writeMemory("core.md", "# Valid Core", "append")
    await writeMemory("core.md", "# Updated Core", "patch", "# Valid Core")
    const coreBakExists = await fs.stat(path.join(${JSON.stringify(memoriesDir)}, "core.md.bak")).then(() => true).catch(() => false)
    assert.equal(coreBakExists, true)

    // 4. Test warning when size crosses 200KB
    const huge = "a".repeat(200005)
    const res = await writeMemory("huge.md", huge, "append")
    assert.match(res, /Warning: File size is currently/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NIRI_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})




