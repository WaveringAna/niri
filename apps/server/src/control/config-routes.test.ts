import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { ConfigStore } from "./config-store"
import { deriveAgentToken, getOrCreateToken } from "./config-auth"
import { registerConfigurationRoutes, type ConfigurationManager } from "./config-routes"

async function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "niri-config-api-"))
  const store = new ConfigStore(path.join(home, "config.db"))
  const token = getOrCreateToken(path.join(home, "admin.token"))
  const scheduled: string[] = []
  const refreshed: string[] = []
  const events: string[] = []
  const manager: ConfigurationManager = {
    list: () => store.list(), validate: () => {},
    refresh: id => { refreshed.push(id); events.push(`refresh:${id}`) },
    schedule: id => { scheduled.push(id); events.push(`schedule:${id}`) },
    start: async id => store.setEnabled(id, true), stop: async id => store.setEnabled(id, false),
    restart: async id => store.get(id),
  }
  const app = Fastify()
  await app.register(async routes => registerConfigurationRoutes(routes, { store, manager, adminToken: token, agentToken: id => deriveAgentToken(token, id) }))
  t.after(async () => { await app.close(); store.close(); fs.rmSync(home, { recursive: true, force: true }) })
  const admin = { authorization: `Bearer ${token}` }
  const agent = (id: string) => ({ authorization: `Bearer ${deriveAgentToken(token, id)}` })
  return { app, store, admin, agent, scheduled, refreshed, events, home, token }
}

test("operator creates a stopped agent; config reads and lifecycle require scoped authority", async t => {
  const { app, admin, agent, home, token } = await fixture(t)
  assert.equal(getOrCreateToken(path.join(home, "admin.token")), token)
  assert.equal(fs.statSync(path.join(home, "admin.token")).mode & 0o777, 0o600)
  assert.equal((await app.inject({ method: "POST", url: "/agents", payload: { id: "nova" } })).statusCode, 403)
  const created = await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova" } })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().enabled, false)
  assert.equal(created.json().config.configPolicy.selfEdit, true)
  assert.equal((await app.inject({ url: "/agents/nova/config", headers: agent("nova") })).statusCode, 200)
  assert.equal((await app.inject({ url: "/agents/nova/config", headers: agent("other") })).statusCode, 403)
  assert.equal((await app.inject({ method: "POST", url: "/agents/nova/start", headers: agent("nova") })).statusCode, 403)
  assert.equal((await app.inject({ method: "POST", url: "/agents/nova/start", headers: admin })).statusCode, 202)
})

test("repl-style edits are revisioned, redacted, and return before application", async t => {
  const { app, admin, agent, scheduled, events } = await fixture(t)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config: { model: { apiKey: "never-show-this" } } } })
  const change = { patch: { model: { name: "a-new-model" } }, expectedRevision: 1, requestId: "same-change", reason: "test self edit" }
  const updated = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: agent("nova"), payload: change })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().revision, 2)
  assert.equal(updated.json().application.state, "pending")
  assert.ok(!updated.body.includes("never-show-this"))
  assert.deepEqual(events.slice(-2), ["refresh:nova", "schedule:nova"])
  const replay = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: agent("nova"), payload: change })
  assert.equal(replay.statusCode, 200, replay.body)
  assert.equal(replay.json().revision, 2)
  assert.ok(scheduled.includes("nova"))
  const stale = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: admin, payload: { patch: { name: "changed" }, expectedRevision: 1 } })
  assert.equal(stale.statusCode, 409)
  const denied = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: agent("nova"), payload: { patch: { configPolicy: { selfEdit: false } }, expectedRevision: 2 } })
  assert.equal(denied.statusCode, 403)
  const history = await app.inject({ url: "/agents/nova/config/history", headers: admin })
  assert.ok(!history.body.includes("never-show-this"))
  assert.equal(history.json().history[0].actor, "agent:nova")
})

test("agent provisions an idempotent signed webhook without exposing other config secrets", async t => {
  const { app, store, admin, agent, scheduled, refreshed } = await fixture(t)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "niri", config: { model: { apiKey: "existing-model-secret" }, configPolicy: { agentWebhooks: true } } } })
  const request = {
    method: "POST" as const,
    url: "/agents/niri/config/webhooks",
    headers: agent("niri"),
    payload: { name: "deploy", expectedRevision: 1, signatureHeader: "X-Hub-Signature-256", requestId: "webhook-create-1", reason: "receive deploys" },
  }
  const created = await app.inject(request)
  assert.equal(created.statusCode, 201, created.body)
  const receipt = created.json()
  assert.match(receipt.secret, /^[a-zA-Z0-9_-]{43}$/)
  assert.equal(receipt.signatureHeader, "x-hub-signature-256")
  assert.equal(receipt.signaturePrefix, "sha256=")
  assert.equal(receipt.agentId, "niri")
  assert.equal(receipt.path, "/agents/niri/trigger/webhook/deploy")
  assert.equal(receipt.revision, 2)
  assert.equal(receipt.requestId, "webhook-create-1")
  assert.ok(scheduled.includes("niri"))
  assert.ok(refreshed.includes("niri"))

  const replay = await app.inject(request)
  assert.equal(replay.statusCode, 201, replay.body)
  assert.equal(replay.json().secret, receipt.secret)
  assert.equal(replay.json().revision, 2)
  assert.equal(store.getRaw("niri")?.webhooks?.deploy?.secret, receipt.secret)
  assert.equal(store.get("niri")?.config.webhooks?.deploy?.secret, "[redacted]")
  assert.doesNotMatch((await app.inject({ url: "/agents/niri/config/history", headers: agent("niri") })).body, new RegExp(`${receipt.secret}|existing-model-secret`))

  const duplicate = await app.inject({ ...request, payload: { name: "deploy", expectedRevision: 2, requestId: "webhook-create-2" } })
  assert.equal(duplicate.statusCode, 409)
  assert.equal(duplicate.json().code, "ALREADY_EXISTS")
  const stale = await app.inject({ ...request, payload: { name: "build", expectedRevision: 1, requestId: "webhook-create-3" } })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().code, "CONFLICT")
  const reused = await app.inject({ ...request, payload: { name: "other", expectedRevision: 1, requestId: "webhook-create-1" } })
  assert.equal(reused.statusCode, 409)
  assert.equal(reused.json().code, "IDEMPOTENCY_CONFLICT")
  assert.equal((await app.inject({ ...request, headers: agent("other") })).statusCode, 403)

  store.update("niri", { actor: "operator", expectedRevision: 2, patch: { webhooks: { deploy: { signatureHeader: "x-rotated-signature" } } } })
  const driftedReplay = await app.inject(request)
  assert.equal(driftedReplay.statusCode, 409)
  assert.equal(driftedReplay.json().code, "IDEMPOTENCY_CONFLICT")

  store.update("niri", { actor: "operator", expectedRevision: 3, patch: { configPolicy: { agentWebhooks: false } } })
  const disabledReplay = await app.inject(request)
  assert.equal(disabledReplay.statusCode, 403)
  assert.equal(disabledReplay.json().code, "POLICY_DENIED")
})

test("webhook provisioning requires operator opt-in and honors the config self-edit switch", async t => {
  const { app, admin, agent } = await fixture(t)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "default" } })
  const optedOut = await app.inject({ method: "POST", url: "/agents/default/config/webhooks", headers: agent("default"), payload: { name: "deploy", expectedRevision: 1, requestId: "default-hook" } })
  assert.equal(optedOut.statusCode, 403)
  assert.equal(optedOut.json().code, "POLICY_DENIED")

  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "locked", config: { configPolicy: { selfEdit: false, agentWebhooks: true } } } })
  const denied = await app.inject({ method: "POST", url: "/agents/locked/config/webhooks", headers: agent("locked"), payload: { name: "deploy", expectedRevision: 1, requestId: "locked-hook" } })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().code, "POLICY_DENIED")
})

test("bad boundary inputs fail without mutating config", async t => {
  const { app, store, admin, agent } = await fixture(t)
  assert.equal((await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "../escape" } })).statusCode, 400)
  assert.equal((await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config: { id: "other" } } })).statusCode, 400)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config: { configPolicy: { agentWebhooks: true } } } })
  for (const expectedRevision of [undefined, -1, "1", 0]) {
    assert.equal((await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: admin, payload: { patch: {}, expectedRevision } })).statusCode, 400)
  }
  assert.equal((await app.inject({ method: "POST", url: "/agents/nova/config/seed", headers: admin, payload: { config: { id: "other", client: "local" }, expectedRevision: 1 } })).statusCode, 400)
  for (const payload of [
    { name: "../escape", expectedRevision: 1, requestId: "bad-name" },
    { name: "__proto__", expectedRevision: 1, requestId: "reserved-name" },
    { name: "deploy", expectedRevision: 1, signatureHeader: "bad header", requestId: "bad-header" },
    { name: "deploy", expectedRevision: 1, signaturePrefix: 42, requestId: "bad-prefix" },
    { name: "deploy", expectedRevision: 1, requestId: "unknown", extra: true },
    { name: "deploy", expectedRevision: 1 },
    { name: "deploy", expectedRevision: 0, requestId: "bad-revision" },
  ]) {
    assert.equal((await app.inject({ method: "POST", url: "/agents/nova/config/webhooks", headers: agent("nova"), payload })).statusCode, 400)
  }
  assert.equal(store.get("nova")?.revision, 1)
})


test("every durable config mutation refreshes routing before reconciliation", async t => {
  const { app, admin, events } = await fixture(t)
  const config = { client: "local", model: { name: "fixed" } }
  const created = await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config, seed: true } })
  assert.equal(created.statusCode, 201, created.body)
  assert.deepEqual(events.slice(-2), ["refresh:nova", "schedule:nova"])

  const patched = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: admin, payload: { patch: { model: { name: "patched" } }, expectedRevision: 1 } })
  assert.equal(patched.statusCode, 200, patched.body)
  assert.deepEqual(events.slice(-2), ["refresh:nova", "schedule:nova"])

  const rolledBack = await app.inject({ method: "POST", url: "/agents/nova/config/rollback", headers: admin, payload: { revision: 1, expectedRevision: 2 } })
  assert.equal(rolledBack.statusCode, 200, rolledBack.body)
  assert.equal(rolledBack.json().config.model.name, "fixed")
  assert.deepEqual(events.slice(-2), ["refresh:nova", "schedule:nova"])

  const next = { ...config, model: { name: "updated" } }
  const preview = await app.inject({ method: "POST", url: "/agents/nova/config/diff", headers: admin, payload: { config: next, expectedRevision: 3 } })
  assert.equal(preview.statusCode, 200, preview.body)
  assert.deepEqual(preview.json().conflicts, [])
  const applied = await app.inject({ method: "POST", url: "/agents/nova/config/seed", headers: admin, payload: { config: next, expectedRevision: 3 } })
  assert.equal(applied.statusCode, 200, applied.body)
  assert.equal(applied.json().config.model.name, "updated")
  assert.deepEqual(events.slice(-2), ["refresh:nova", "schedule:nova"])
})
