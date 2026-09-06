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
  const manager: ConfigurationManager = {
    list: () => store.list(), validate: () => {}, schedule: id => { scheduled.push(id) },
    start: async id => store.setEnabled(id, true), stop: async id => store.setEnabled(id, false),
    restart: async id => store.get(id),
  }
  const app = Fastify()
  await app.register(async routes => registerConfigurationRoutes(routes, { store, manager, adminToken: token, agentToken: id => deriveAgentToken(token, id) }))
  t.after(async () => { await app.close(); store.close(); fs.rmSync(home, { recursive: true, force: true }) })
  const admin = { authorization: `Bearer ${token}` }
  const agent = (id: string) => ({ authorization: `Bearer ${deriveAgentToken(token, id)}` })
  return { app, store, admin, agent, scheduled, home, token }
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
  const { app, admin, agent, scheduled } = await fixture(t)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config: { model: { apiKey: "never-show-this" } } } })
  const change = { patch: { model: { name: "a-new-model" } }, expectedRevision: 1, requestId: "same-change", reason: "test self edit" }
  const updated = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: agent("nova"), payload: change })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().revision, 2)
  assert.equal(updated.json().application.state, "pending")
  assert.ok(!updated.body.includes("never-show-this"))
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

test("bad boundary inputs fail without mutating config", async t => {
  const { app, admin } = await fixture(t)
  assert.equal((await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "../escape" } })).statusCode, 400)
  assert.equal((await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config: { id: "other" } } })).statusCode, 400)
  await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova" } })
  for (const expectedRevision of [undefined, -1, "1", 0]) {
    assert.equal((await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: admin, payload: { patch: {}, expectedRevision } })).statusCode, 400)
  }
  assert.equal((await app.inject({ method: "POST", url: "/agents/nova/config/seed", headers: admin, payload: { config: { id: "other", client: "local" }, expectedRevision: 1 } })).statusCode, 400)
})


test("file creation keeps a seed baseline and enforces operator-owned paths", async t => {
  const { app, admin, agent } = await fixture(t)
  const config = { client: "local", model: { name: "fixed" }, configPolicy: { enforcedPaths: ["model.name"] } }
  const created = await app.inject({ method: "POST", url: "/agents", headers: admin, payload: { id: "nova", config, seed: true } })
  assert.equal(created.statusCode, 201, created.body)
  const denied = await app.inject({ method: "PATCH", url: "/agents/nova/config", headers: agent("nova"), payload: { patch: { model: { name: "other" } }, expectedRevision: 1 } })
  assert.equal(denied.statusCode, 403, denied.body)
  const next = { ...config, model: { name: "updated" } }
  const preview = await app.inject({ method: "POST", url: "/agents/nova/config/diff", headers: admin, payload: { config: next, expectedRevision: 1 } })
  assert.equal(preview.statusCode, 200, preview.body)
  assert.deepEqual(preview.json().conflicts, [])
  const applied = await app.inject({ method: "POST", url: "/agents/nova/config/seed", headers: admin, payload: { config: next, expectedRevision: 1 } })
  assert.equal(applied.statusCode, 200, applied.body)
  assert.equal(applied.json().config.model.name, "updated")
})
