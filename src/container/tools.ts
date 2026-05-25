import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FILE_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  IMAGE_ROOT,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
  resolveMaxLines,
} from "./config"
import { currentWorkingDirectory, runOneOff, runRaw } from "./shell"
import type { EditResult, ImageToolPayload, ModelImageInput } from "./types"

function invokesSudo(command: string): boolean {
  return /(^|[;&|({]\s*)sudo(\s|$)/.test(String(command ?? ""))
}

/**
 * Run a shell command.
 * Output is capped at `maxLines` lines (default 150, 40 for known-verbose commands).
 * When truncated, a "[truncated]" header is prepended so niri knows lines were dropped.
 * Pass `maxLines: 0` to disable truncation entirely.
 *
 * @param command - Shell command to execute.
 * @param maxLines - Optional line cap override (`0` disables truncation).
 * @param timeoutMs - Optional command timeout in milliseconds.
 * @returns Cleaned command output, potentially truncated with a header.
 */
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
  if (lines.length <= cap) return raw

  const kept = lines.slice(-cap)
  return `[truncated — showing last ${cap} of ${lines.length} lines]\n${kept.join("\n")}`
}

function normalizeImagePath(filePath: string): string {
  const raw = String(filePath ?? "").trim()
  if (!raw) throw new Error("image path is required")
  const normalized = path.posix.normalize(raw)
  if (!(normalized === IMAGE_ROOT || normalized.startsWith(`${IMAGE_ROOT}/`))) {
    throw new Error(`image path must be inside ${IMAGE_ROOT}`)
  }
  return normalized
}

async function resolveLocalPath(filePath: string, timeoutMs: number): Promise<string> {
  const raw = String(filePath ?? "").trim()
  if (!raw) throw new Error("path is required")
  if (path.isAbsolute(raw)) return path.normalize(raw)
  return path.resolve(await currentWorkingDirectory(timeoutMs), raw)
}

function imageMimeFromBytes(filePath: string, data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif"
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM") return "image/bmp"
  if (
    data.length >= 4 &&
    (data.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      data.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) {
    return "image/tiff"
  }

  const ext = path.extname(filePath).toLowerCase()
  const byExt: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
  }
  return byExt[ext] ?? null
}

/**
 * Read an image from the container and encode it as a data URL for multimodal input.
 * Only paths inside the configured IMAGE_ROOT are allowed.
 *
 * @param filePath - Absolute image path inside the allowed image root.
 * @param timeoutMs - Optional read timeout in milliseconds.
 * @returns Parsed image payload suitable for model multimodal input.
 * @throws If validation, decoding, or path checks fail.
 */
export async function readImageForModel(filePath: string, timeoutMs?: number): Promise<ModelImageInput> {
  const safePath = normalizeImagePath(filePath)
  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!USE_DOCKER_SHELL) {
    let st
    try {
      st = await fs.stat(safePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`could not stat ${safePath}: ${message}`)
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${safePath}`)
    if (st.size <= 0) throw new Error(`file is empty: ${safePath}`)
    if (st.size > IMAGE_MAX_BYTES) throw new Error(`file too large: ${st.size} bytes (max ${IMAGE_MAX_BYTES})`)

    const data = await fs.readFile(safePath)
    const mime = imageMimeFromBytes(safePath, data)
    if (!mime) throw new Error(`unsupported image type: ${safePath}`)
    return {
      path: safePath,
      mime,
      bytes: data.length,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
    }
  }

  const py = [
    "import base64, imghdr, json, mimetypes, os, stat, sys, warnings",
    "warnings.filterwarnings('ignore', category=DeprecationWarning)",
    "path = sys.argv[1]",
    "max_bytes = int(sys.argv[2])",
    "def out(obj):",
    "    print(json.dumps(obj, ensure_ascii=False))",
    "try:",
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
    "    guessed, _ = mimetypes.guess_type(path)",
    "    if guessed and guessed.startswith('image/'):",
    "        mime = guessed",
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

  const raw = await runRaw(pythonCommand(py, [safePath, String(IMAGE_MAX_BYTES)]), { timeoutMs: opTimeoutMs })

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

/**
 * Escape a string for safe interpolation into a POSIX shell command.
 */
function shellQuote(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

function pythonCommand(source: string, args: string[] = []): string {
  const token = `NIRI_PY_${randomBytes(8).toString("hex").toUpperCase()}`
  const scriptPath = `/tmp/niri-${randomBytes(8).toString("hex")}.py`
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

/**
 * Read a file from the container with optional line-range selection.
 * Returns content with a metadata header showing the line range and total line count.
 * Defaults to lines 1–100 when no range is given.
 *
 * @param filePath - Path to the file inside the container.
 * @param startLine - Inclusive 1-based start line.
 * @param endLine - Optional inclusive 1-based end line.
 * @param timeoutMs - Optional read timeout in milliseconds.
 * @returns Header plus selected file content.
 */
export async function readFile(filePath: string, startLine = 1, endLine?: number, timeoutMs?: number): Promise<string> {
  const start = Math.max(1, Math.trunc(Number(startLine)) || 1)
  const end = endLine !== undefined ? Math.max(start, Math.trunc(Number(endLine)) || start) : undefined
  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) {
    throw new Error(`readFile: invalid line range (${startLine}, ${endLine})`)
  }

  if (!USE_DOCKER_SHELL) {
    const resolvedPath = await resolveLocalPath(filePath, opTimeoutMs)
    const content = await fs.readFile(resolvedPath, "utf8")
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

/**
 * Edit a file by replacing an exact snippet of text.
 * old_text must appear exactly once; errors clearly if 0 or >1 matches.
 *
 * Uses an in-container python transform so we do not stream huge file bodies
 * through the PTY (which is fragile on very large files).
 *
 * @param filePath - File path to edit.
 * @param oldText - Exact text to replace (must match exactly once).
 * @param newText - Replacement text.
 * @param timeoutMs - Optional operation timeout in milliseconds.
 * @returns Structured edit result describing success/failure.
 */
export async function editFile(filePath: string, oldText: string, newText: string, timeoutMs?: number): Promise<EditResult> {
  if (oldText.length === 0) {
    return { ok: false, message: "old_text must not be empty" }
  }

  const opTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_FILE_TIMEOUT_MS)

  if (!USE_DOCKER_SHELL) {
    const resolvedPath = await resolveLocalPath(filePath, opTimeoutMs)
    let content: string
    try {
      content = await fs.readFile(resolvedPath, "utf8")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `could not read ${filePath}: ${message}` }
    }

    const count = content.split(oldText).length - 1
    if (count === 0) return { ok: false, message: `old_text not found in ${filePath}` }
    if (count > 1) return { ok: false, message: `old_text found ${count} times in ${filePath} — must be unique` }

    try {
      await fs.writeFile(resolvedPath, content.replace(oldText, newText), "utf8")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `could not write ${filePath}: ${message}` }
    }

    const linesDelta = newText.split("\n").length - oldText.split("\n").length
    const sign = linesDelta >= 0 ? "+" : ""
    return {
      ok: true,
      message: `edited ${filePath} (${sign}${linesDelta} lines)`,
    }
  }

  const payload = wrappedBase64(JSON.stringify({ path: filePath, old_text: oldText, new_text: newText }))
  const payloadToken = `NIRI_EDIT_PAYLOAD_${randomBytes(8).toString("hex").toUpperCase()}`
  const payloadPath = `/tmp/niri-edit-${randomBytes(8).toString("hex")}.b64`

  const py = [
    "import base64, json, sys",
    "def out(obj):",
    "    print(json.dumps(obj, ensure_ascii=False))",
    "with open(sys.argv[1], 'r', encoding='ascii') as f:",
    "    payload = json.loads(base64.b64decode(f.read()).decode('utf-8'))",
    "path = payload.get('path', '')",
    "old = payload.get('old_text', '')",
    "new = payload.get('new_text', '')",
    "if old == '':",
    "    out({'ok': False, 'message': 'old_text must not be empty'})",
    "    raise SystemExit(0)",
    "try:",
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
    "try:",
    "    with open(path, 'w', encoding='utf-8') as f:",
    "        f.write(updated)",
    "except Exception as e:",
    "    out({'ok': False, 'message': f'could not write {path}: {e}'})",
    "    raise SystemExit(0)",
    "out({'ok': True})",
  ].join("\n")

  const raw = await runRaw(
    [
      `cat > ${shellQuote(payloadPath)} << '${payloadToken}'`,
      payload,
      payloadToken,
      pythonCommand(py, [payloadPath]),
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
