import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ClientImageArtifact } from "@mira/harness-protocol"
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FILE_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  IMAGE_ROOT,
  MAX_LINE_LENGTH,
  MAX_RESULT_BYTES,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
  resolveMaxLines,
} from "./config.js"
import { currentWorkingDirectory, runOneOff, runRaw } from "./shell.js"
import type { EditResult, ImageToolPayload } from "./types.js"

function invokesSudo(command: string): boolean {
  return /(^|[;&|({]\s*)sudo(\s|$)/.test(String(command ?? ""))
}

export async function runCommand(command: string, maxLines?: number, timeoutMs?: number): Promise<string> {
  const cap = resolveMaxLines(command, maxLines)
  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  const raw = invokesSudo(command)
    ? await runOneOff(command, await currentWorkingDirectory(opTimeoutMs), { timeoutMs: opTimeoutMs })
    : await runRaw(command, {
        timeoutMs: opTimeoutMs,
        // Always detach stdin from the PTY. The agent cannot type into a prompt,
        // so an interactive child (clack/inquirer prompts, pagers, REPLs) would
        // only consume the trailing completion sentinels still buffered in the
        // PTY — poisoning completion detection and flooding the session with
        // prompt redraw garbage. /dev/null gives such children immediate EOF
        // so they abort cleanly and bash reaches the end sentinel.
        redirectStdinToDevNull: true,
      })

  if (cap === 0) return raw

  const lines = raw.split("\n")
  const processedLines = lines.map((line) => {
    if (line.length > MAX_LINE_LENGTH) {
      return line.slice(0, MAX_LINE_LENGTH) + ` ... [truncated line of ${line.length} characters]`
    }
    return line
  })

  if (processedLines.length <= cap) {
    return processedLines.join("\n")
  }

  const kept = processedLines.slice(-cap)
  return `[truncated — showing last ${cap} of ${lines.length} lines]\n${kept.join("\n")}`
}

function normalizeImagePath(filePath: string): string {
  const raw = String(filePath ?? "").trim()
  if (!raw) throw new Error("image path is required")
  const normalized = USE_DOCKER_SHELL ? path.posix.normalize(raw) : path.resolve(raw)
  if (!(normalized === IMAGE_ROOT || normalized.startsWith(`${IMAGE_ROOT}/`))) {
    throw new Error(`image path must be inside ${IMAGE_ROOT}`)
  }
  return normalized
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveLocalImagePath(filePath: string, timeoutMs: number): Promise<string> {
  const [root, target] = await withTimeout(
    Promise.all([fs.realpath(IMAGE_ROOT), fs.realpath(filePath)]),
    timeoutMs,
    "image path resolution",
  )
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`image path must resolve inside ${IMAGE_ROOT}`)
  }
  return target
}

async function resolveLocalPath(filePath: string, timeoutMs: number): Promise<string> {
  const raw = String(filePath ?? "").trim()
  if (!raw) throw new Error("path is required")
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(await currentWorkingDirectory(timeoutMs), raw)
  return withTimeout(fs.realpath(resolved), timeoutMs, "file path resolution")
}

function localFileLimitBytes(): number {
  return Math.max(2_000_000, MAX_RESULT_BYTES * 4)
}

async function readBoundedLocalFile(filePath: string, timeoutMs: number): Promise<{ content: string; mode: number }> {
  const handle = await withTimeout(fs.open(filePath, "r"), timeoutMs, "file open")
  try {
    const stat = await withTimeout(handle.stat(), timeoutMs, "file stat")
    if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`)
    const limit = localFileLimitBytes()
    if (stat.size > limit) throw new Error(`file is too large to read safely (${stat.size} > ${limit} bytes)`)
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    const { bytesRead } = await withTimeout(handle.read(buffer, 0, buffer.length, 0), timeoutMs, "file read")
    if (bytesRead > limit) throw new Error(`file is too large to read safely (>${limit} bytes)`)
    const after = await withTimeout(handle.stat(), timeoutMs, "file stat")
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(`file changed while it was being read: ${filePath}`)
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), mode: stat.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

function isValidPng(data: Buffer): boolean {
  return (
    data.length >= 33 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.readUInt32BE(8) === 13 &&
    data.subarray(12, 16).toString("ascii") === "IHDR" &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(20) > 0
  )
}

function isValidGif(data: Buffer): boolean {
  const header = data.length >= 6 ? data.subarray(0, 6).toString("ascii") : ""
  return (
    data.length >= 10 &&
    (header === "GIF87a" || header === "GIF89a") &&
    data.readUInt16LE(6) > 0 &&
    data.readUInt16LE(8) > 0
  )
}

function isValidJpeg(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
    return false
  }

  let offset = 2
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset++
    if (offset >= data.length) return false

    const marker = data[offset++]!
    if (marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.length) return false

    const segmentLength = data.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > data.length) return false

    const isSofMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSofMarker) {
      if (segmentLength < 7) return false
      const height = data.readUInt16BE(offset + 3)
      const width = data.readUInt16BE(offset + 5)
      return width > 0 && height > 0
    }

    offset += segmentLength
  }

  return false
}

function isValidWebp(data: Buffer): boolean {
  if (data.length < 16) return false
  if (data.subarray(0, 4).toString("ascii") !== "RIFF" || data.subarray(8, 12).toString("ascii") !== "WEBP") return false
  const riffSize = data.readUInt32LE(4) + 8
  if (riffSize > data.length) return false
  const chunk = data.subarray(12, 16).toString("ascii")
  return chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X"
}

function isValidBmp(data: Buffer): boolean {
  if (data.length < 54 || data.subarray(0, 2).toString("ascii") !== "BM") return false
  const declaredSize = data.readUInt32LE(2)
  const pixelOffset = data.readUInt32LE(10)
  const dibSize = data.readUInt32LE(14)
  const width = data.readInt32LE(18)
  const height = data.readInt32LE(22)
  return declaredSize <= data.length && pixelOffset < data.length && dibSize >= 40 && width !== 0 && height !== 0
}

function isValidTiff(data: Buffer): boolean {
  if (data.length < 8) return false
  const little = data.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
  const big = data.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  if (!little && !big) return false
  const firstIfdOffset = little ? data.readUInt32LE(4) : data.readUInt32BE(4)
  return firstIfdOffset >= 8 && firstIfdOffset < data.length
}

function imageMimeFromBytes(data: Buffer): string | null {
  if (isValidPng(data)) {
    return "image/png"
  }
  if (isValidJpeg(data)) return "image/jpeg"
  if (isValidGif(data)) return "image/gif"
  if (isValidWebp(data)) return "image/webp"
  if (isValidBmp(data)) return "image/bmp"
  if (isValidTiff(data)) return "image/tiff"
  return null
}

export async function readImageForModel(filePath: string, timeoutMs?: number): Promise<ClientImageArtifact> {
  const safePath = normalizeImagePath(filePath)
  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!USE_DOCKER_SHELL) {
    const resolvedPath = await resolveLocalImagePath(safePath, opTimeoutMs)
    let st
    try {
      st = await withTimeout(fs.stat(resolvedPath), opTimeoutMs, "image stat")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`could not stat ${safePath}: ${message}`)
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${safePath}`)
    if (st.size <= 0) throw new Error(`file is empty: ${safePath}`)
    if (st.size > IMAGE_MAX_BYTES) throw new Error(`file too large: ${st.size} bytes (max ${IMAGE_MAX_BYTES})`)

    const data = await fs.readFile(resolvedPath, { signal: AbortSignal.timeout(opTimeoutMs) })
    const mime = imageMimeFromBytes(data)
    if (!mime) throw new Error(`unsupported image type: ${safePath}`)
    return {
      path: safePath,
      mime,
      bytes: data.length,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
    }
  }

  const py = [
    "import base64, imghdr, json, os, stat, sys, warnings",
    "warnings.filterwarnings('ignore', category=DeprecationWarning)",
    "path = os.path.realpath(sys.argv[1])",
    "max_bytes = int(sys.argv[2])",
    "root = os.path.realpath(sys.argv[3])",
    "def out(obj):",
    "    print(json.dumps(obj, ensure_ascii=False))",
    "try:",
    "    if os.path.commonpath([root, path]) != root:",
    "        out({'ok': False, 'message': f'image path must resolve inside {root}'})",
    "        raise SystemExit(0)",
    "    st = os.stat(path)",
    "except FileNotFoundError:",
    "    out({'ok': False, 'message': f'file not found: {path}'})",
    "    raise SystemExit(0)",
    "except Exception as e:",
    "    out({'ok': False, 'message': f'could not stat {path}: {e}'})",
    "    raise SystemExit(0)",
    "if not stat.S_ISREG(st.st_mode):",
    "    out({'ok': False, 'message': f'not a regular file: {path}'})",
    "    raise SystemExit(0)",
    "if st.st_size <= 0:",
    "    out({'ok': False, 'message': f'file is empty: {path}'})",
    "    raise SystemExit(0)",
    "if st.st_size > max_bytes:",
    "    out({'ok': False, 'message': f'file too large: {st.st_size} bytes (max {max_bytes})'})",
    "    raise SystemExit(0)",
    "with open(path, 'rb') as f:",
    "    data = f.read()",
    "kind = imghdr.what(None, data)",
    "mime_map = {",
    "    'jpeg': 'image/jpeg',",
    "    'png': 'image/png',",
    "    'gif': 'image/gif',",
    "    'webp': 'image/webp',",
    "    'bmp': 'image/bmp',",
    "    'tiff': 'image/tiff',",
    "}",
    "mime = mime_map.get(kind)",
    "if not mime:",
    "    out({'ok': False, 'message': f'unsupported image type: {path}'})",
    "    raise SystemExit(0)",
    "encoded = base64.b64encode(data).decode('ascii')",
    "out({",
    "    'ok': True,",
    "    'path': path,",
    "    'mime': mime,",
    "    'bytes': len(data),",
    "    'data_url': 'data:' + mime + ';base64,' + encoded,",
    "})",
  ].join("\n")

  const raw = await runRaw(pythonCommand(py, [safePath, String(IMAGE_MAX_BYTES), IMAGE_ROOT]), { timeoutMs: opTimeoutMs })

  let parsed: ImageToolPayload

  try {
    parsed = JSON.parse(raw.trim()) as ImageToolPayload
  } catch {
    throw new Error(`image_tool failed for ${safePath}: ${raw.trim() || "unknown error"}`)
  }

  if (!parsed?.ok) {
    throw new Error(parsed?.message ?? `image_tool failed for ${safePath}`)
  }

  const bytes = parsed.bytes
  if (!parsed.path || !parsed.mime || !parsed.data_url || typeof bytes !== "number" || !Number.isFinite(bytes)) {
    throw new Error(`image_tool returned invalid payload for ${safePath}`)
  }

  return {
    path: parsed.path,
    mime: parsed.mime,
    bytes,
    dataUrl: parsed.data_url,
  }
}

function shellQuote(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

function pythonCommand(source: string, args: string[] = []): string {
  const token = `HARNESS_PY_${randomBytes(8).toString("hex").toUpperCase()}`
  const scriptPath = `/tmp/harness-${randomBytes(8).toString("hex")}.py`
  return [
    `cat > ${shellQuote(scriptPath)} << '${token}'`,
    source,
    token,
    `python3 ${shellQuote(scriptPath)} ${args.map(shellQuote).join(" ")}`,
    `rm -f ${shellQuote(scriptPath)}`,
  ].join("\n")
}

function wrappedBase64(str: string): string {
  return Buffer.from(str, "utf8").toString("base64").match(/.{1,76}/g)?.join("\n") ?? ""
}

export async function readFile(filePath: string, startLine = 1, endLine?: number, timeoutMs?: number): Promise<string> {
  const start = Math.max(1, Math.trunc(Number(startLine)) || 1)
  const end = endLine !== undefined ? Math.max(start, Math.trunc(Number(endLine)) || start) : undefined
  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) {
    throw new Error(`readFile: invalid line range (${startLine}, ${endLine})`)
  }

  if (!USE_DOCKER_SHELL) {
    const resolvedPath = await resolveLocalPath(filePath, opTimeoutMs)
    const { content } = await readBoundedLocalFile(resolvedPath, opTimeoutMs)
    const lines = content.split("\n")
    if (lines.at(-1) === "") lines.pop()
    const totalLines = lines.length
    const effectiveEnd = end ?? Math.min(start + 99, totalLines > 0 ? totalLines : start + 99)
    const selected = lines.slice(start - 1, effectiveEnd).join("\n")
    const rangeStr = `lines ${start}–${effectiveEnd}`
    const totalStr = totalLines > 0 ? ` of ${totalLines} total` : ""
    return `[${filePath}  ${rangeStr}${totalStr}]\n${selected}`
  }

  const quoted = shellQuote(filePath)

  const countRaw = await runRaw(`wc -l < ${quoted} 2>/dev/null || echo 0`, { timeoutMs: opTimeoutMs })
  const totalLines = parseInt(countRaw.trim(), 10) || 0

  const effectiveEnd = end ?? Math.min(start + 99, totalLines > 0 ? totalLines : start + 99)

  const content = await runRaw(`sed -n '${start},${effectiveEnd}p' ${quoted} 2>&1`, { timeoutMs: opTimeoutMs })

  const rangeStr = `lines ${start}–${effectiveEnd}`
  const totalStr = totalLines > 0 ? ` of ${totalLines} total` : ""
  const header = `[${filePath}  ${rangeStr}${totalStr}]\n`

  return header + content
}

// Docker edits stay in-container so large file bodies never cross the PTY.
export async function editFile(filePath: string, oldText: string, newText: string, timeoutMs?: number): Promise<EditResult> {
  if (oldText.length === 0) {
    return { ok: false, message: "old_text must not be empty" }
  }

  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!USE_DOCKER_SHELL) {
    const resolvedPath = await resolveLocalPath(filePath, opTimeoutMs)
    let content: string
    let mode: number
    try {
      const snapshot = await readBoundedLocalFile(resolvedPath, opTimeoutMs)
      content = snapshot.content
      mode = snapshot.mode
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `could not read ${filePath}: ${message}` }
    }

    const count = content.split(oldText).length - 1
    if (count === 0) return { ok: false, message: `old_text not found in ${filePath}` }
    if (count > 1) return { ok: false, message: `old_text found ${count} times in ${filePath} — must be unique` }

    const temporary = path.join(path.dirname(resolvedPath), `.${path.basename(resolvedPath)}.${randomBytes(8).toString("hex")}.tmp`)
    try {
      const current = await readBoundedLocalFile(resolvedPath, opTimeoutMs)
      if (current.content !== content) return { ok: false, message: `file changed before edit could be applied: ${filePath}` }
      const handle = await fs.open(temporary, "wx", mode)
      try {
        await handle.writeFile(content.replace(oldText, newText), "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, resolvedPath)
      await fs.chmod(resolvedPath, mode)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `could not write ${filePath}: ${message}` }
    } finally {
      await fs.rm(temporary, { force: true })
    }

    const linesDelta = newText.split("\n").length - oldText.split("\n").length
    const sign = linesDelta >= 0 ? "+" : ""
    return {
      ok: true,
      message: `edited ${filePath} (${sign}${linesDelta} lines)`,
    }
  }

  const payload = wrappedBase64(JSON.stringify({ path: filePath, old_text: oldText, new_text: newText }))
  const payloadToken = `HARNESS_EDIT_PAYLOAD_${randomBytes(8).toString("hex").toUpperCase()}`
  const payloadPath = `/tmp/harness-edit-${randomBytes(8).toString("hex")}.b64`

  const py = [
    "import base64, json, os, sys, tempfile",
    "def out(obj):",
    "    print(json.dumps(obj, ensure_ascii=False))",
    "with open(sys.argv[1], 'r', encoding='ascii') as f:",
    "    payload = json.loads(base64.b64decode(f.read()).decode('utf-8'))",
    "path = os.path.realpath(payload.get('path', ''))",
    "old = payload.get('old_text', '')",
    "new = payload.get('new_text', '')",
    "max_bytes = int(sys.argv[2])",
    "if old == '':",
    "    out({'ok': False, 'message': 'old_text must not be empty'})",
    "    raise SystemExit(0)",
    "try:",
    "    original_stat = os.stat(path)",
    "    if original_stat.st_size > max_bytes:",
    "        out({'ok': False, 'message': f'file is too large to edit safely ({original_stat.st_size} > {max_bytes} bytes)'})",
    "        raise SystemExit(0)",
    "    with open(path, 'r', encoding='utf-8') as f:",
    "        content = f.read()",
    "except FileNotFoundError:",
    "    out({'ok': False, 'message': f'could not read {path}: file not found'})",
    "    raise SystemExit(0)",
    "except Exception as e:",
    "    out({'ok': False, 'message': f'could not read {path}: {e}'})",
    "    raise SystemExit(0)",
    "count = content.count(old)",
    "if count == 0:",
    "    out({'ok': False, 'message': f'old_text not found in {path}'})",
    "    raise SystemExit(0)",
    "if count > 1:",
    "    out({'ok': False, 'message': f'old_text found {count} times in {path} — must be unique'})",
    "    raise SystemExit(0)",
    "updated = content.replace(old, new, 1)",
    "temporary = None",
    "try:",
    "    with open(path, 'r', encoding='utf-8') as f:",
    "        if f.read() != content:",
    "            out({'ok': False, 'message': f'file changed before edit could be applied: {path}'})",
    "            raise SystemExit(0)",
    "    fd, temporary = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', suffix='.tmp', dir=os.path.dirname(os.path.abspath(path)))",
    "    with os.fdopen(fd, 'w', encoding='utf-8') as f:",
    "        f.write(updated)",
    "        f.flush()",
    "        os.fsync(f.fileno())",
    "    os.chmod(temporary, original_stat.st_mode & 0o777)",
    "    os.replace(temporary, path)",
    "    temporary = None",
    "except Exception as e:",
    "    out({'ok': False, 'message': f'could not write {path}: {e}'})",
    "    raise SystemExit(0)",
    "finally:",
    "    if temporary:",
    "        try: os.unlink(temporary)",
    "        except FileNotFoundError: pass",
    "out({'ok': True})",
  ].join("\n")

  const raw = await runRaw(
    [
      `cat > ${shellQuote(payloadPath)} << '${payloadToken}'`,
      payload,
      payloadToken,
      pythonCommand(py, [payloadPath, String(localFileLimitBytes())]),
      `rm -f ${shellQuote(payloadPath)}`,
    ].join("\n"),
    { timeoutMs: opTimeoutMs },
  )

  let parsed: { ok?: boolean; message?: string } | null = null
  try {
    parsed = JSON.parse(raw.trim()) as { ok?: boolean; message?: string }
  } catch {
    return { ok: false, message: `edit failed for ${filePath}: ${raw.trim() || "unknown error"}` }
  }

  if (!parsed.ok) {
    return { ok: false, message: parsed.message ?? `edit failed for ${filePath}` }
  }

  const linesDelta = newText.split("\n").length - oldText.split("\n").length
  const sign = linesDelta >= 0 ? "+" : ""
  return {
    ok: true,
    message: `edited ${filePath} (${sign}${linesDelta} lines)`,
  }
}
