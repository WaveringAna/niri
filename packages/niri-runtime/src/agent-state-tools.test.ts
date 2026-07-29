import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { __agentStateToolsTest, applyHashlineEdit, memoryLineHash } from "./agent-state-tools"

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
  await fs.writeFile(path.join(memoriesDir, "journal", "long.md"), Array.from({ length: 110 }, (_, i) => `Line ${i + 1}`).join("\n"), "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "long_sectioned.md"), Array.from({ length: 105 }, (_, i) => `Line ${i + 1}`).concat("## Section boundary", "More content").join("\n"), "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "wide-a.md"), Array.from({ length: 120 }, (_, i) => `broad-needle ${i + 1} ${"x".repeat(1_500)}`).join("\n"), "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "wide-b.md"), Array.from({ length: 20 }, (_, i) => `broad-needle other ${i + 1}`).join("\n"), "utf8")

  // Write hidden files/directories to verify they are filtered out
  await fs.mkdir(path.join(memoriesDir, ".git"), { recursive: true })
  await fs.writeFile(path.join(memoriesDir, ".git", "config"), "some config", "utf8")
  await fs.writeFile(path.join(memoriesDir, ".gitignore"), "node_modules", "utf8")
  await fs.writeFile(path.join(memoriesDir, ".legit-hidden.md"), "legit content", "utf8")

  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { readMemory, listMemory, grepMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Test listMemory (should filter out .git and .gitignore, but keep .legit-hidden.md)
    const filesList = await listMemory()
    assert.equal(filesList, ".legit-hidden.md\\ncore.md\\njournal/2026-07-12.md\\njournal/long.md\\njournal/long_sectioned.md\\njournal/sectioned.md\\njournal/wide-a.md\\njournal/wide-b.md")
    
    // 2. Test readMemory whole file
    const contentAll = await readMemory("journal/2026-07-12.md")
    assert.match(contentAll, /Line 1\\nLine 2\\nLine 3/)
    
    // 3. Test readMemory line ranges
    const contentRange = await readMemory("journal/2026-07-12.md", 2, 3)
    assert.match(contentRange, /Line 2\\nLine 3/)
    assert.doesNotMatch(contentRange, /Line 1/)
    
    // 4. Test readMemory non-existent file
    await assert.rejects(() => readMemory("missing.md"))
    
    // 5. Test header stopping logic on small file returns all lines when no endLine is specified
    const sec1 = await readMemory("journal/sectioned.md", 1)
    assert.match(sec1, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)
    assert.doesNotMatch(sec1, /Note: Content stopped/)
    
    // 6. Test that range checks continue past endLine to the next header (e.g. read 1-1 continues to 2)
    const extendedSec = await readMemory("journal/sectioned.md", 1, 1)
    assert.match(extendedSec, /Sec 1\\nContent 1/)
    assert.doesNotMatch(extendedSec, /Sec 2/)
    assert.match(extendedSec, /Note: Content stopped before the next section header on line 3/)
    
    // 7. Test reading all sections by passing endLine past the last header
    const bothSecs = await readMemory("journal/sectioned.md", 1, 4)
    assert.match(bothSecs, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)

    // 8. Test memory_grep exact substring matching
    const grep1 = await grepMemory("Content 2")
    assert.match(grep1, /journal\\/sectioned\\.md:4#[0-9a-f]{6}: Content 2/)

    // 9. Test memory_grep case-insensitive matching
    const grep2 = await grepMemory("CONTENT 2", true)
    assert.match(grep2, /journal\\/sectioned\\.md:4#[0-9a-f]{6}: Content 2/)

    // 10. Test memory_grep empty result
    const grepEmpty = await grepMemory("somethinguniqueandmissing")
    assert.equal(grepEmpty, "(no matches found)")
    await assert.rejects(() => grepMemory("x".repeat(1_001)), /query exceeds 1000 bytes/)

    // 11. Broad results are bounded and leave anchors for targeted reads
    const broadGrep = await grepMemory("broad-needle")
    assert.ok(Buffer.byteLength(broadGrep, "utf8") <= 32_000)
    assert.match(broadGrep, /showing \\d+ of 140 matches across 2 files; \\d+ matches omitted/)
    assert.match(broadGrep, /journal\\/wide-a\\.md:1#[0-9a-f]{6}:/)
    assert.match(broadGrep, /journal\\/wide-[ab]\\.md: \\d+ omitted matches in lines \\d+-\\d+/)
    assert.ok(broadGrep.includes('memory_read({"path":"journal/wide-'))
    assert.ok(broadGrep.includes('"start_line":'))
    assert.ok(broadGrep.includes('"hashline":true})'))
    assert.match(broadGrep, /use a narrower memory_grep query/)

    // 12. Test 100-line read limit note warning
    const longSec = await readMemory("journal/long.md", 1)
    assert.match(longSec, /Note: Content stopped due to the 100-line read limit. To read further, call 'memory_read' with start_line=101/)

    // 13. Test default 100-line range extending to next section header
    const longSecHeader = await readMemory("journal/long_sectioned.md", 1)
    assert.match(longSecHeader, /Line 105/)
    assert.doesNotMatch(longSecHeader, /Section boundary/)
    assert.match(longSecHeader, /Note: Content stopped before the next section header on line 106/)
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





test("hashline edits replace, delete, and resolve stale line numbers by hash", () => {
  const doc = "alpha\nbeta\ngamma\ndelta\n"
  const hash = (line: string) => memoryLineHash(line)

  const single = applyHashlineEdit(doc, `2#${hash("beta")}`, "BETA")
  assert.equal(single.result, "alpha\nBETA\ngamma\ndelta\n")
  assert.deepEqual([single.startLine, single.endLine], [2, 2])

  const range = applyHashlineEdit(doc, `2#${hash("beta")}-3#${hash("gamma")}`, "middle")
  assert.equal(range.result, "alpha\nmiddle\ndelta\n")

  const deletion = applyHashlineEdit(doc, `3#${hash("gamma")}`, "")
  assert.equal(deletion.result, "alpha\nbeta\ndelta\n")

  // Line number drifted (a line was inserted above) but the hash still resolves.
  const drifted = "inserted\nalpha\nbeta\ngamma\ndelta\n"
  const corrected = applyHashlineEdit(drifted, `2#${hash("beta")}`, "BETA")
  assert.equal(corrected.result, "inserted\nalpha\nBETA\ngamma\ndelta\n")
  assert.equal(corrected.startLine, 3)

  assert.throws(() => applyHashlineEdit(doc, `2#${hash("missing")}`, "x"), /not found/)
  assert.throws(() => applyHashlineEdit(doc, `1#${hash("beta")}-3#${hash("alpha")}`, "x"), /inverted/)
  assert.throws(() => applyHashlineEdit(doc, "line two", "x"), /invalid start anchor/)

  const dupes = "same\nother\nsame\n"
  assert.throws(() => applyHashlineEdit(dupes, `9#${hash("same")}`, "x"), /ambiguous/)
})

test("memory hashline mode edits files end to end", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-hashline-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  const testFile = path.join(memoriesDir, "journal.md")
  await fs.writeFile(testFile, "# Journal\n\nfirst entry\nsecond entry\nthird entry\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { writeMemory, readMemory, grepMemory, memoryLineHash } = await import(${JSON.stringify(moduleUrl)})

    const annotated = await readMemory("journal.md", 1, 5, true)
    assert.match(annotated, new RegExp("3#" + memoryLineHash("first entry") + " first entry"))

    const edited = await writeMemory("journal.md", "updated entry", "hashline", "3#" + memoryLineHash("first entry"))
    assert.match(edited, /replaced lines 3/)

    const afterEdit = await readMemory("journal.md", 1, 10)
    assert.match(afterEdit, /updated entry/)
    assert.ok(!afterEdit.includes("first entry"))

    const deleted = await writeMemory("journal.md", "", "hashline", "4#" + memoryLineHash("second entry") + "-5#" + memoryLineHash("third entry"))
    assert.match(deleted, /replaced lines 4/)
    const afterDelete = await readMemory("journal.md", 1, 10)
    assert.ok(!afterDelete.includes("second entry"))
    assert.ok(!afterDelete.includes("third entry"))

    const grep = await grepMemory("updated", false)
    assert.match(grep, new RegExp("journal.md:3#" + memoryLineHash("updated entry") + ": updated entry"))

    await assert.rejects(() => writeMemory("journal.md", "x", "hashline", "1#000000"), /not found|ambiguous/)
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
