export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "user"; text: string; source: string; triggeredAt: string; clientId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string }

export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export interface CreateChatClientOptions {
  baseUrl: string
  fetchImpl?: FetchLike
  clientId?: string
}

export interface StreamOptions {
  signal?: AbortSignal
  onEvent: (event: StreamEvent) => void
}

export interface ChatClient {
  send: (content: string) => Promise<{ ok: true }>
  getStatus: () => Promise<{ running: boolean; idle: boolean }>
  stream: (options: StreamOptions) => Promise<void>
}

type UnknownEvent = {
  type?: unknown
  text?: unknown
  source?: unknown
  triggeredAt?: unknown
  clientId?: unknown
  name?: unknown
  args?: unknown
  result?: unknown
}

const normalizeUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl

const toEvent = (raw: unknown): StreamEvent | null => {
  if (!raw || typeof raw !== "object") return null

  const event = raw as UnknownEvent

  if (
    event.type === "user" &&
    typeof event.text === "string" &&
    typeof event.source === "string" &&
    typeof event.triggeredAt === "string"
  ) {
    return {
      type: "user",
      text: event.text,
      source: event.source,
      triggeredAt: event.triggeredAt,
      clientId: typeof event.clientId === "string" ? event.clientId : undefined,
    }
  }

  if (event.type === "thinking" && typeof event.text === "string") {
    return { type: "thinking", text: event.text }
  }

  if (
    event.type === "tool" &&
    typeof event.name === "string" &&
    typeof event.result === "string" &&
    event.args &&
    typeof event.args === "object"
  ) {
    return {
      type: "tool",
      name: event.name,
      args: event.args as Record<string, unknown>,
      result: event.result,
    }
  }

  if (typeof event.text === "string") {
    return { type: "text", text: event.text }
  }

  return null
}

const parseError = async (res: Response): Promise<string> => {
  const fallback = `${res.status} ${res.statusText}`.trim()

  try {
    const data = (await res.json()) as { error?: unknown }
    if (typeof data.error === "string" && data.error.trim()) return data.error
  } catch {
    // ignore non-json errors
  }

  return fallback || "request failed"
}

const splitLines = (chunkBuffer: string): { lines: string[]; rest: string } => {
  const normalized = chunkBuffer.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  const rest = lines.pop() ?? ""
  return { lines, rest }
}

export function createChatClient(options: CreateChatClientOptions): ChatClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = normalizeUrl(options.baseUrl)
  const clientId = options.clientId
  const url = (path: string) => `${baseUrl}${path}`

  const send: ChatClient["send"] = async (content) => {
    const res = await fetchImpl(url("/trigger/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, ...(clientId ? { clientId } : {}) }),
    })

    if (!res.ok) {
      throw new Error(await parseError(res))
    }

    return { ok: true }
  }

  const getStatus: ChatClient["getStatus"] = async () => {
    const res = await fetchImpl(url("/status"))
    if (!res.ok) {
      throw new Error(await parseError(res))
    }

    const data = (await res.json()) as { running?: unknown; idle?: unknown }
    return { running: data.running === true, idle: data.idle === true }
  }

  const stream: ChatClient["stream"] = async ({ signal, onEvent }) => {
    const res = await fetchImpl(url("/chat/stream"), { signal })
    if (!res.ok || !res.body) {
      throw new Error(res.ok ? "stream body missing" : await parseError(res))
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { lines, rest } = splitLines(buffer)
      buffer = rest

      for (const line of lines) {
        if (!line.startsWith("data:")) continue

        const payload = line.slice(5).trimStart()
        if (!payload) continue

        try {
          const event = toEvent(JSON.parse(payload))
          if (event) onEvent(event)
        } catch {
          // ignore malformed SSE data lines
        }
      }
    }
  }

  return {
    send,
    getStatus,
    stream,
  }
}
