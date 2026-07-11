import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import Fastify, { type FastifyInstance } from "fastify"

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL?.trim() || "gpt-5.6-sol"
const DEFAULT_REASONING_EFFORT = process.env.CODEX_BRIDGE_REASONING_EFFORT?.trim() || "low"
const DEFAULT_BODY_LIMIT = 64 * 1024 * 1024

type CodexAuth = {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string }
  last_refresh?: string
  [key: string]: unknown
}

type BridgeOptions = {
  authPath?: string
  fetchImpl?: typeof fetch
}

let bridgeServer: FastifyInstance | null = null

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1]
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null
  } catch { return null }
}

function accountIdFromToken(token: string): string | undefined {
  return decodeJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id
}

async function loadCodexAuth(authPath: string, fetchImpl: typeof fetch): Promise<{ token: string; accountId?: string }> {
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as CodexAuth
  let token = auth.tokens?.access_token?.trim()
  const refresh = auth.tokens?.refresh_token?.trim()
  if (!token) throw new Error(`Codex access token is missing from ${authPath}; run codex login`)

  const expiresAt = Number(decodeJwt(token)?.exp ?? 0) * 1000
  if (refresh && expiresAt <= Date.now() + 60_000) {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
    })
    if (!response.ok) throw new Error(`Codex OAuth refresh failed (${response.status}): ${await response.text()}`)
    const next = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string }
    if (!next.access_token) throw new Error("Codex OAuth refresh response did not contain an access token")
    token = next.access_token
    auth.tokens = {
      ...auth.tokens,
      access_token: token,
      refresh_token: next.refresh_token || refresh,
      id_token: next.id_token || auth.tokens?.id_token,
      account_id: accountIdFromToken(token) || auth.tokens?.account_id,
    }
    auth.last_refresh = new Date().toISOString()
    const tmp = `${authPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, authPath)
  }
  return { token, accountId: auth.tokens?.account_id || accountIdFromToken(token) }
}

function mapModel(model: unknown): string {
  const value = typeof model === "string" ? model.trim().toLowerCase() : ""
  if (!value || value === "codex" || value === "openai-codex" || value === "codex-latest") return DEFAULT_MODEL
  return String(model)
}

function mapMessageContent(role: "user" | "assistant", content: unknown): any[] {
  const textType = role === "assistant" ? "output_text" : "input_text"
  if (typeof content === "string") return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return [{ type: textType, text: JSON.stringify(content ?? "") }]
  return content.map((part) => {
    if (!part || typeof part !== "object") return { type: textType, text: String(part ?? "") }
    if (part.type === "text") return { ...part, type: textType }
    if (part.type === "image_url") {
      const image = part.image_url
      return {
        type: "input_image",
        image_url: typeof image === "string" ? image : image?.url,
        ...(typeof image === "object" && image?.detail ? { detail: image.detail } : {}),
      }
    }
    return part
  })
}

function mapMessages(messages: any[]): { instructions?: string; input: any[] } {
  const instructions: string[] = []
  const input: any[] = []
  for (const message of messages || []) {
    const role = message?.role
    if (role === "system" || role === "developer") {
      instructions.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    } else if (role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })
    } else if (role === "assistant" && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: "assistant", content: [{ type: "output_text", text: String(message.content) }] })
      for (const call of message.tool_calls) input.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}" })
    } else if (role === "user" || role === "assistant") {
      input.push({ role, content: mapMessageContent(role, message.content) })
    }
  }
  return { instructions: instructions.length ? instructions.join("\n\n") : undefined, input }
}

function mapTools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.filter((tool) => tool?.type === "function").map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters || { type: "object", properties: {} },
    strict: tool.function.strict ?? false,
  }))
}

function parseSse(text: string): any[] {
  const events: any[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    if (!data || data === "[DONE]") continue
    try { events.push(JSON.parse(data)) } catch { /* ignore non-JSON keepalives */ }
  }
  return events
}

function collectResult(events: any[]): { content: string; toolCalls: any[]; usage?: any; responseId?: string } {
  let content = ""
  const toolCalls: any[] = []
  let usage: any
  let responseId: string | undefined
  for (const event of events) {
    if (event.type === "response.output_text.delta") content += event.delta || ""
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      toolCalls.push({ id: event.item.call_id || event.item.id, type: "function", function: { name: event.item.name, arguments: event.item.arguments || "{}" } })
    }
    if (event.response) {
      responseId ||= event.response.id
      usage ||= event.response.usage
    }
  }
  return { content, toolCalls, usage, responseId }
}

export function createCodexBridgeServer(options: BridgeOptions = {}): FastifyInstance {
  const configuredBodyLimit = Number.parseInt(process.env.CODEX_BRIDGE_BODY_LIMIT_BYTES || "", 10)
  const bodyLimit = Number.isSafeInteger(configuredBodyLimit) && configuredBodyLimit > 0
    ? configuredBodyLimit
    : DEFAULT_BODY_LIMIT
  const app = Fastify({ logger: false, bodyLimit })
  const authPath = options.authPath || process.env.CODEX_AUTH_PATH?.trim() || path.join(os.homedir(), ".codex", "auth.json")
  const fetchImpl = options.fetchImpl || fetch

  app.get("/health", async () => ({ ok: true, authPath }))
  app.get("/v1/models", async () => ({ object: "list", data: [{ id: "Codex", object: "model" }, { id: DEFAULT_MODEL, object: "model" }] }))
  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as any
    const { token, accountId } = await loadCodexAuth(authPath, fetchImpl)
    const mapped = mapMessages(body.messages || [])
    const sessionId = typeof body.user === "string" && body.user.trim() ? body.user.trim() : crypto.randomUUID()
    const turnId = crypto.randomUUID()
    const windowId = `${sessionId}:0`
    const turnMetadata = JSON.stringify({
      session_id: sessionId,
      thread_id: sessionId,
      turn_id: turnId,
      window_id: windowId,
      request_kind: "turn",
      thread_source: "user",
      sandbox: "external",
      turn_started_at_unix_ms: Date.now(),
    })
    const upstreamBody: any = {
      model: mapModel(body.model),
      input: mapped.input,
      instructions: mapped.instructions,
      tools: mapTools(body.tools),
      tool_choice: body.tool_choice,
      stream: true,
      store: false,
      reasoning: { effort: body.reasoning_effort || DEFAULT_REASONING_EFFORT },
      text: { verbosity: body.verbosity || "low" },
      parallel_tool_calls: body.parallel_tool_calls ?? true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: sessionId,
      client_metadata: {
        thread_id: sessionId,
        session_id: sessionId,
        "x-codex-window-id": windowId,
        turn_id: turnId,
        "x-codex-turn-metadata": turnMetadata,
      },
    }
    for (const key of Object.keys(upstreamBody)) if (upstreamBody[key] === undefined) delete upstreamBody[key]
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "content-type": "application/json",
      originator: "codex_exec",
      "session-id": sessionId,
      "thread-id": sessionId,
      "x-codex-window-id": windowId,
      "x-codex-turn-metadata": turnMetadata,
      "x-client-request-id": sessionId,
      "user-agent": "codex_exec/0.142.3 (Mac OS; arm64) niri-codex-bridge/1.0",
    }
    if (accountId) headers["chatgpt-account-id"] = accountId
    const upstream = await fetchImpl(CODEX_URL, { method: "POST", headers, body: JSON.stringify(upstreamBody) })
    const raw = await upstream.text()
    if (!upstream.ok) return reply.code(upstream.status).send({ error: { message: raw || upstream.statusText, type: "codex_upstream_error" } })
    const events = parseSse(raw)
    const result = collectResult(events)
    const created = Math.floor(Date.now() / 1000)
    const id = result.responseId || `chatcmpl-${crypto.randomUUID()}`
    const finishReason = result.toolCalls.length ? "tool_calls" : "stop"
    if (body.stream) {
      reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache")
      const chunks: string[] = []
      if (result.content) chunks.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: mapModel(body.model), choices: [{ index: 0, delta: { role: "assistant", content: result.content }, finish_reason: null }] })}\n\n`)
      if (result.toolCalls.length) chunks.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: mapModel(body.model), choices: [{ index: 0, delta: { tool_calls: result.toolCalls.map((call, index) => ({ index, ...call })) }, finish_reason: null }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: mapModel(body.model), choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`)
      return reply.send(chunks.join(""))
    }
    return reply.send({
      id, object: "chat.completion", created, model: mapModel(body.model),
      choices: [{ index: 0, message: { role: "assistant", content: result.content || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) }, finish_reason: finishReason }],
      usage: result.usage ? { prompt_tokens: result.usage.input_tokens || 0, completion_tokens: result.usage.output_tokens || 0, total_tokens: result.usage.total_tokens || 0 } : undefined,
    })
  })
  return app
}

export async function startCodexBridge(): Promise<void> {
  if (process.env.CODEX_BRIDGE_ENABLED?.trim().toLowerCase() !== "true" || bridgeServer) return
  const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT || "8001", 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid Codex bridge port: ${process.env.CODEX_BRIDGE_PORT}`)
  bridgeServer = createCodexBridgeServer()
  await bridgeServer.listen({ port, host: "127.0.0.1" })
  console.log(`[codex bridge] listening on http://127.0.0.1:${port}`)
}

export async function stopCodexBridge(): Promise<void> {
  if (!bridgeServer) return
  await bridgeServer.close()
  bridgeServer = null
}

export const __codexBridgeTest = { mapMessages, mapTools, parseSse, collectResult }
