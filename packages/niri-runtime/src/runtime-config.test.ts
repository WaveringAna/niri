import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { RuntimeConfigService } from "./runtime-config"
import { ServiceError } from "./server-native-services"

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return server
}

function address(server: http.Server): string {
  const value = server.address()
  if (!value || typeof value === "string") throw new Error("missing test address")
  return `http://127.0.0.1:${value.port}`
}

test("runtime config is unavailable without a scoped control endpoint", async () => {
  const service = new RuntimeConfigService({ agentId: "niri", environment: {} })
  await assert.rejects(service.get({}), (error: unknown) => error instanceof ServiceError && error.code === "unavailable")
})

test("runtime config forwards only this agent and its scoped bearer token", async () => {
  let observed: { method?: string; url?: string; authorization?: string; body?: unknown } = {}
  const server = await listen(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ revision: 4, application: "restart-required" }))
  })
  try {
    const service = new RuntimeConfigService({
      agentId: "niri",
      environment: { NIRI_CONFIG_SERVER_URL: address(server), NIRI_CONFIG_TOKEN: "agent-scoped-token" },
    })
    const receipt = await service.update({ patch: { model: { name: "test" } }, expected_revision: 3, reason: "test", request_id: "retry-1" })
    assert.deepEqual(receipt, { requestId: "retry-1", revision: 4, application: "restart-required" })
    assert.deepEqual(observed, {
      method: "PATCH",
      url: "/agents/niri/config",
      authorization: "Bearer agent-scoped-token",
      body: { patch: { model: { name: "test" } }, expectedRevision: 3, reason: "test", requestId: "retry-1" },
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("runtime config provisions a webhook through the scoped control origin", async () => {
  let observed: { method?: string; url?: string; authorization?: string; body?: unknown } = {}
  const server = await listen(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    }
    response.writeHead(201, { "content-type": "application/json" })
    response.end(JSON.stringify({
      name: "deploy", secret: "generated", signatureHeader: "x-hub-signature-256", signaturePrefix: "sha256=",
      path: "/agents/niri/trigger/webhook/deploy", revision: 4,
    }))
  })
  try {
    const origin = address(server)
    const service = new RuntimeConfigService({ agentId: "niri", environment: { NIRI_CONFIG_SERVER_URL: origin, NIRI_CONFIG_TOKEN: "agent-scoped-token" } })
    const receipt = await service.createWebhook({
      name: "deploy", expected_revision: 3, signature_header: "X-Hub-Signature-256", signature_prefix: "sha256=", reason: "receive deploys", request_id: "hook-1",
    }) as Record<string, unknown>
    assert.equal(receipt.url, `${origin}/agents/niri/trigger/webhook/deploy`)
    assert.equal(receipt.secret, "generated")
    assert.equal(receipt.requestId, "hook-1")
    assert.deepEqual(observed, {
      method: "POST",
      url: "/agents/niri/config/webhooks",
      authorization: "Bearer agent-scoped-token",
      body: { name: "deploy", expectedRevision: 3, signatureHeader: "X-Hub-Signature-256", signaturePrefix: "sha256=", reason: "receive deploys", requestId: "hook-1" },
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("webhook transport failures preserve the retry request id", async () => {
  const service = new RuntimeConfigService({
    agentId: "niri",
    environment: { NIRI_CONFIG_SERVER_URL: "http://127.0.0.1:4000", NIRI_CONFIG_TOKEN: "scoped" },
    fetch: async () => { throw new Error("offline") },
  })
  await assert.rejects(
    service.createWebhook({ name: "deploy", expected_revision: 1, request_id: "hook-retry" }),
    (error: unknown) => error instanceof ServiceError && error.code === "unavailable" && /request_id "hook-retry"/.test(error.message),
  )
})

test("runtime config rejects arbitrary target fields and non-loopback control URLs", async () => {
  const service = new RuntimeConfigService({ agentId: "niri", environment: { NIRI_CONFIG_SERVER_URL: "http://example.test", NIRI_CONFIG_TOKEN: "scoped" } })
  await assert.rejects(service.get({}), (error: unknown) => error instanceof ServiceError && error.code === "unavailable")
  const local = new RuntimeConfigService({ agentId: "niri", environment: { NIRI_CONFIG_SERVER_URL: "http://127.0.0.1:1", NIRI_CONFIG_TOKEN: "scoped" } })
  await assert.rejects(local.update({ patch: {}, expected_revision: 1, request_id: "r", actor: "admin" }), (error: unknown) => error instanceof ServiceError && error.code === "invalid_argument")
})


test("runtime config never follows a redirect with its bearer token", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(302, { location: "http://example.test/agents/niri/config" })
    response.end()
  })
  try {
    const service = new RuntimeConfigService({ agentId: "niri", environment: { NIRI_CONFIG_SERVER_URL: address(server), NIRI_CONFIG_TOKEN: "agent-scoped-token" } })
    await assert.rejects(service.get({}), (error: unknown) => error instanceof ServiceError && error.code === "unavailable")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
