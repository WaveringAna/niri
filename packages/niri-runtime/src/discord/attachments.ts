import { createHash } from "node:crypto"
import dns from "node:dns/promises"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { Agent } from "undici"
import type { Dispatcher } from "undici-types"
import { AGENT_ID, NIRI_HOME } from "../agent-config"
import { clientTools } from "../client"
import type { ClientToolExecutor } from "@mira/harness-core"

/** Discord rejects bot uploads beyond this size. */
export const DISCORD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
const DISCORD_ATTACHMENT_MAX_FILES = 10
const URL_FETCH_TIMEOUT_MS = 30_000
const URL_FETCH_MAX_REDIRECTS = 5

/** Blocks loopback, private, link-local, and otherwise non-public addresses. */
function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase()
    if (normalized === "::1" || normalized === "::") return false
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe90:") || normalized.startsWith("fea0:") || normalized.startsWith("feb0:")) return false
    if (/^f[c-d][0-9a-f]{2}:/.test(normalized)) return false
    // IPv4-mapped IPv6 addresses are checked by their embedded v4 octets.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    return mapped ? isPublicAddress(mapped[1]!) : true
  }
  const parts = address.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false
  return true
}

/**
 * A dispatcher whose DNS lookup pins and validates the address used for the
 * connection, so attachment downloads cannot be steered at loopback, LAN, or
 * link-local services (including via DNS rebinding between validation and
 * connect). Combined with manual redirect handling, every hop is validated.
 */
function assertPublicUrlTarget(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`attachment url must be http(s): ${url}`)
  }
  if (url.username || url.password) throw new Error("attachment url must not contain credentials")
  // Literal IP hosts never reach the DNS lookup, so check them directly.
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new Error(`attachment url targets a non-public address: ${host}`)
  }
}

function createPublicOnlyDispatcher(): Dispatcher {
  return new Agent({
    connect: {
        lookup: (hostname, _options, callback) => {
          dns
            .lookup(hostname, { all: true, verbatim: true })
            .then((addresses) => {
              const publicAddress = addresses.find((entry) => isPublicAddress(entry.address))
              if (!publicAddress) {
                callback(new Error(`attachment url host resolves to a non-public address: ${hostname}`), "", 4)
                return
              }
              callback(null, publicAddress.address, publicAddress.family)
            })
            .catch((error) => callback(error as Error, "", 4))
        },
      },
    }) as unknown as Dispatcher
}

async function fetchPublicUrl(url: URL): Promise<{ data: Buffer; finalUrl: URL }> {
  const dispatcher = createPublicOnlyDispatcher()
  try {
    let current = url
    let response: Response | null = null
    for (let hop = 0; hop <= URL_FETCH_MAX_REDIRECTS; hop++) {
      assertPublicUrlTarget(current)
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
        redirect: "manual",
        dispatcher,
      }
      response = await fetch(current, init)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        await response.body?.cancel().catch(() => {})
        if (!location) throw new Error(`attachment download redirect without location (${response.status}): ${current}`)
        const next = new URL(location, current)
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          throw new Error(`attachment download redirected to a non-http(s) url: ${next}`)
        }
        if (next.username || next.password) throw new Error("attachment url must not contain credentials")
        current = next
        response = null
        continue
      }
      break
    }
    if (!response) throw new Error(`attachment download exceeded ${URL_FETCH_MAX_REDIRECTS} redirects: ${url}`)
    if (!response.ok) throw new Error(`attachment download failed (${response.status}): ${current}`)
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > DISCORD_ATTACHMENT_MAX_BYTES) {
      throw new Error(`attachment exceeds the ${DISCORD_ATTACHMENT_MAX_BYTES} byte Discord limit (${length} bytes)`)
    }
    if (!response.body) throw new Error(`attachment download failed (no body): ${current}`)
    const reader = response.body.getReader()
    const parts: Buffer[] = []
    let received = 0
    let fullyRead = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          fullyRead = true
          break
        }
        received += value.byteLength
        if (received > DISCORD_ATTACHMENT_MAX_BYTES) {
          throw new Error(`attachment exceeds the ${DISCORD_ATTACHMENT_MAX_BYTES} byte Discord limit`)
        }
        parts.push(Buffer.from(value))
      }
    } finally {
      // Cancel unread bodies so the connection aborts instead of stalling close().
      if (!fullyRead) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return { data: Buffer.concat(parts), finalUrl: current }
  } finally {
    await dispatcher.close().catch(() => {})
  }
}

export type DiscordAttachmentInput = {
  path?: string
  client_path?: string
  url?: string
  name?: string
  description?: string
}

export type ResolvedDiscordAttachment = {
  name: string
  data: Buffer
  description?: string
}

type BlobChunk = {
  data: string
  offset: number
  size: number
  mtime_ms: number
  sha256: string
  eof: boolean
}

/**
 * Reads a whole file from the attached tool client via chunked read_blob calls.
 * Every chunk is hash-verified and the file's size/mtime must stay constant
 * across chunks, so a truncated or torn transfer fails instead of producing a
 * corrupt upload.
 */
async function readClientBlob(clientPath: string, executor: ClientToolExecutor = clientTools): Promise<Buffer> {
  const parts: Buffer[] = []
  let offset = 0
  let size = -1
  let mtimeMs = -1

  for (let iteration = 0; iteration < 1000; iteration++) {
    const result = await executor.execute({
      agentId: AGENT_ID,
      tool: "read_blob",
      args: { path: clientPath, offset },
      timeoutMs: 120_000,
    })
    if (result.status !== "ok") {
      throw new Error(`client blob read failed for '${clientPath}': ${result.output ?? result.status}`)
    }
    const output = result.output ?? ""
    if (!output || output.includes("[truncated at")) {
      throw new Error(`blob transport failed for '${clientPath}': the client truncated a chunk; the file is too large to transfer`)
    }
    let chunk: BlobChunk
    try {
      chunk = JSON.parse(output) as BlobChunk
    } catch {
      throw new Error(`blob transport failed for '${clientPath}': unreadable chunk (possible transport truncation)`)
    }
    const data = Buffer.from(chunk.data, "base64")
    if (createHash("sha256").update(data).digest("hex") !== chunk.sha256) {
      throw new Error(`blob transport failed for '${clientPath}': chunk hash mismatch at offset ${chunk.offset}`)
    }
    if (chunk.offset !== offset) {
      throw new Error(`blob transport failed for '${clientPath}': unexpected chunk offset ${chunk.offset}, expected ${offset}`)
    }
    if (size === -1) {
      size = chunk.size
      mtimeMs = chunk.mtime_ms
      if (size > DISCORD_ATTACHMENT_MAX_BYTES) {
        throw new Error(`attachment exceeds the ${DISCORD_ATTACHMENT_MAX_BYTES} byte Discord limit (${size} bytes)`)
      }
    } else if (chunk.size !== size || chunk.mtime_ms !== mtimeMs) {
      throw new Error(`file changed on the client while it was being transferred: ${clientPath}`)
    }
    parts.push(data)
    offset += data.length
    if (chunk.eof) {
      const blob = Buffer.concat(parts)
      if (blob.length !== size) {
        throw new Error(`blob transport failed for '${clientPath}': received ${blob.length} of ${size} bytes`)
      }
      return blob
    }
    if (data.length === 0) {
      throw new Error(`blob transport failed for '${clientPath}': empty chunk before end of file`)
    }
  }
  throw new Error(`blob transport failed for '${clientPath}': too many chunks`)
}

async function readWorkerBlob(workerPath: string): Promise<{ data: Buffer; resolvedPath: string }> {
  const raw = String(workerPath ?? "").trim()
  if (!raw) throw new Error("attachment path is required")
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(NIRI_HOME, raw)
  const stat = await fs.stat(resolved).catch(() => {
    throw new Error(`attachment file not found: ${raw} (looked for ${resolved})`)
  })
  if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${raw}`)
  if (stat.size > DISCORD_ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment exceeds the ${DISCORD_ATTACHMENT_MAX_BYTES} byte Discord limit (${stat.size} bytes)`)
  }
  return { data: await fs.readFile(resolved), resolvedPath: resolved }
}

async function readUrlBlob(url: URL): Promise<{ data: Buffer; finalUrl: URL }> {
  assertPublicUrlTarget(url)
  return fetchPublicUrl(url)
}

/**
 * Resolves attachment inputs to upload-ready buffers. Each input names exactly
 * one source: `path` (a file on this worker, relative to the agent home),
 * `client_path` (a file on the attached tool client), or `url` (downloaded by
 * the worker). Total payload stays under the Discord upload limit.
 */
export async function resolveDiscordAttachments(
  attachments: DiscordAttachmentInput[],
  options: {
    readClientBlob?: (clientPath: string) => Promise<Buffer>
    fetchUrl?: (url: URL) => Promise<{ data: Buffer; finalUrl: URL }>
  } = {},
): Promise<ResolvedDiscordAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  if (attachments.length > DISCORD_ATTACHMENT_MAX_FILES) {
    throw new Error(`too many attachments (${attachments.length} > ${DISCORD_ATTACHMENT_MAX_FILES})`)
  }
  const clientReader = options.readClientBlob ?? readClientBlob
  const urlFetcher = options.fetchUrl ?? readUrlBlob

  const resolved: ResolvedDiscordAttachment[] = []
  let totalBytes = 0
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment !== "object") throw new Error(`attachment ${index + 1} must be an object`)
    const sources = [attachment.path, attachment.client_path, attachment.url].filter((value) => typeof value === "string" && value.trim())
    if (sources.length !== 1) {
      throw new Error(`attachment ${index + 1} must set exactly one of path, client_path, or url`)
    }

    let data: Buffer
    let fallbackName: string
    if (attachment.path?.trim()) {
      const worker = await readWorkerBlob(attachment.path)
      data = worker.data
      fallbackName = path.basename(worker.resolvedPath)
    } else if (attachment.client_path?.trim()) {
      data = await clientReader(attachment.client_path.trim())
      fallbackName = path.basename(attachment.client_path.trim())
    } else {
      const remote = await urlFetcher(new URL(attachment.url!.trim()))
      data = remote.data
      fallbackName = path.basename(remote.finalUrl.pathname) || "attachment"
    }

    totalBytes += data.length
    if (totalBytes > DISCORD_ATTACHMENT_MAX_BYTES) {
      throw new Error(`attachments exceed the ${DISCORD_ATTACHMENT_MAX_BYTES} byte Discord limit in total`)
    }
    resolved.push({
      name: attachment.name?.trim() || fallbackName,
      data,
      ...(attachment.description?.trim() ? { description: attachment.description.trim() } : {}),
    })
  }
  return resolved
}

export const __discordAttachmentsTest = { readClientBlob, isPublicAddress }
