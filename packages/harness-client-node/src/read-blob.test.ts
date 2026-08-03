import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { configureNodeToolRuntime } from "./config.js"
import { readBlobChunk } from "./tools.js"


type BlobChunkResult = {
  data: string
  offset: number
  size: number
  mtime_ms: number
  sha256: string
  eof: boolean
}

test("read_blob chunks reassemble byte-identical files with verified hashes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-read-blob-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  configureNodeToolRuntime({ workspaceRoot: root })
  t.after(() => configureNodeToolRuntime({}))

  // Large enough to require multiple chunks even at the default result cap.
  const original = randomBytes(700 * 1024)
  const blobPath = path.join(root, "blob.bin")
  await fs.writeFile(blobPath, original)

  const parts: Buffer[] = []
  let offset = 0
  let eof = false
  let chunks = 0
  while (!eof) {
    const parsed = JSON.parse(await readBlobChunk(blobPath, offset)) as BlobChunkResult
    const data = Buffer.from(parsed.data, "base64")
    assert.equal(createHash("sha256").update(data).digest("hex"), parsed.sha256)
    assert.equal(parsed.offset, offset)
    assert.equal(parsed.size, original.length)
    parts.push(data)
    offset += data.length
    eof = parsed.eof
    chunks++
    assert.ok(chunks < 100, "chunk loop did not terminate")
  }

  assert.ok(chunks > 1, "expected the read to span multiple chunks")
  assert.deepEqual(Buffer.concat(parts), original)
})

test("read_blob rejects out-of-range offsets and oversized files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "niri-read-blob-limits-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  configureNodeToolRuntime({ workspaceRoot: root, readBlobMaxBytes: 1024 })
  t.after(() => configureNodeToolRuntime({}))

  const smallPath = path.join(root, "small.bin")
  const bigPath = path.join(root, "big.bin")
  await fs.writeFile(smallPath, randomBytes(512))
  await fs.writeFile(bigPath, randomBytes(2048))

  await assert.rejects(() => readBlobChunk(smallPath, 513), /beyond end of file/)
  await assert.rejects(() => readBlobChunk(bigPath, 0), /too large for blob transport/)
  await assert.rejects(() => readBlobChunk(path.join(root, "missing.bin"), 0), /file path resolution|ENOENT/i)
})
