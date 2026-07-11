import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("searchMemory includes semantic-only vector candidates and recall accepts them", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-memory-search-"))
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  const moduleUrl = (filePath: string) => new URL(filePath, import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import path from "node:path"

    const [{ initDb, getDb, isVecAvailable, MEMORY_EMBEDDING_DIMENSIONS }, { vectorParam }, search] =
      await Promise.all([
        import(${JSON.stringify(moduleUrl("./db.ts"))}),
        import(${JSON.stringify(moduleUrl("./memory/sync.ts"))}),
        import(${JSON.stringify(moduleUrl("./memory/search.ts"))}),
      ])

    initDb()
    if (!isVecAvailable()) process.exit(0)

    const db = getDb()
    const docPath = path.join(process.env.NIRI_HOME, "memories", "journal", "2026-06-06.md")
    const documentId = Number(
      db
        .prepare(\`
          insert into memory_documents (path, kind, title, mtime_ms, content_hash, updated_at)
          values (?, 'journal', 'capsule notes', 1, 'hash', datetime('now'))
        \`)
        .run(docPath).lastInsertRowid,
    )
    const chunkId = Number(
      (() => {
        const longChunkText =
          "the bauble protocol keeps archive capsules near the console. " +
          "full chunk content should survive agent recall. ".repeat(12) +
          "semantic-tail-marker"
        return db
          .prepare(\`
            insert into memory_chunks (document_id, chunk_index, title, heading_path, chunk_text, tags)
            values (?, 0, 'bauble protocol', null, ?, 'capsule')
          \`)
          .run(documentId, longChunkText).lastInsertRowid
      })(),
    )

    const queryVector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0))
    db
      .prepare("insert or replace into memory_chunk_vec(rowid, embedding) values (?, ?)")
      .run(BigInt(chunkId), vectorParam(queryVector))

    const profile = await search.buildSearchProfile({
      sender: null,
      source: null,
      body: "vector memory retrieval context",
    })
    const hits = await search.searchMemory(profile, {}, 1, 5, {
      vector: queryVector,
      chatterSimilarity: null,
      recallIntentSimilarity: 1,
    })

    assert.equal(hits[0]?.chunkId, chunkId)
    assert.ok((hits[0]?.semanticSimilarity ?? 0) > 0.99)
    assert.equal(search.isRelevant(hits, profile), true)

    const result = search.toMemorySearchResult(hits[0])
    assert.ok(result.content.endsWith("semantic-tail-marker"))
    assert.equal(result.preview, result.content)
    assert.ok(search.buildMemoryRecallMessage(hits).includes("semantic-tail-marker"))
  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NIRI_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf-8").on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf-8").on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})
