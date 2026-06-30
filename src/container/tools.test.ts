import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { IMAGE_MAX_BYTES, IMAGE_ROOT, USE_DOCKER_SHELL } from "./config"
import { readImageForModel } from "./tools"

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
)

function pngLikeBytes(size: number): Buffer {
  const data = Buffer.alloc(size)
  ONE_BY_ONE_PNG.copy(data)
  return data
}

test("default image tool limit is 1MB", (t) => {
  if (process.env.IMAGE_TOOL_MAX_BYTES) {
    t.skip("IMAGE_TOOL_MAX_BYTES overrides the default")
    return
  }

  assert.equal(IMAGE_MAX_BYTES, 1_000_000)
})

test("readImageForModel accepts files up to IMAGE_MAX_BYTES and rejects larger files", async (t) => {
  if (USE_DOCKER_SHELL) {
    t.skip("local filesystem image limit test does not run through Docker shell")
    return
  }
  if (IMAGE_MAX_BYTES > 5_000_000) {
    t.skip("configured image limit is too large for a focused unit test")
    return
  }

  await fs.mkdir(IMAGE_ROOT, { recursive: true })
  const dir = await fs.mkdtemp(path.join(IMAGE_ROOT, "image-limit-"))

  try {
    const acceptedPath = path.join(dir, "accepted.png")
    await fs.writeFile(acceptedPath, pngLikeBytes(IMAGE_MAX_BYTES))

    const accepted = await readImageForModel(acceptedPath, 5_000)
    assert.equal(accepted.bytes, IMAGE_MAX_BYTES)
    assert.equal(accepted.mime, "image/png")

    const oversizedPath = path.join(dir, "oversized.png")
    await fs.writeFile(oversizedPath, pngLikeBytes(IMAGE_MAX_BYTES + 1))

    await assert.rejects(
      readImageForModel(oversizedPath, 5_000),
      new RegExp(`file too large: ${IMAGE_MAX_BYTES + 1} bytes \\(max ${IMAGE_MAX_BYTES}\\)`),
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("readImageForModel rejects non-image bytes even with an image extension", async (t) => {
  if (USE_DOCKER_SHELL) {
    t.skip("local filesystem image validation test does not run through Docker shell")
    return
  }

  await fs.mkdir(IMAGE_ROOT, { recursive: true })
  const dir = await fs.mkdtemp(path.join(IMAGE_ROOT, "image-validation-"))

  try {
    const errorPagePath = path.join(dir, "downloaded.png")
    await fs.writeFile(errorPagePath, "<html><body>Source image is unreachable</body></html>")

    await assert.rejects(readImageForModel(errorPagePath, 5_000), /unsupported image type/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
