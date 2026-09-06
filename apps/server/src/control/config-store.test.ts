import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ConfigError, ConfigStore } from "./config-store.js"

async function store(t: test.TestContext): Promise<ConfigStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-config-store-")); const result = new ConfigStore(path.join(dir, "config.db"))
  t.after(() => { result.close(); return fs.rm(dir, { recursive: true, force: true }) })
  return result
}
const config = (id = "mira") => ({ id, client: "local", model: { provider: "openai" as const, name: "a" } })

test("CAS, request id replay, and persistence", async (t) => {
  const db = await store(t)
  const created = db.create({ config: config(), actor: "operator", requestId: "create-1" })
  assert.equal(created.enabled, false); assert.equal(created.revision, 1)
  assert.equal(db.create({ config: config(), actor: "operator", requestId: "create-1" }).revision, 1)
  assert.throws(() => db.update("mira", { actor: "operator", expectedRevision: 4, patch: { model: { name: "b" } } }), (error: unknown) => error instanceof ConfigError && error.code === "CONFLICT")
  assert.equal(db.update("mira", { actor: "operator", expectedRevision: 1, patch: { model: { name: "b" } }, requestId: "change" }).revision, 2)
  assert.throws(() => db.update("mira", { actor: "operator", expectedRevision: 2, patch: { model: { name: "c" } }, requestId: "change" }), (error: unknown) => error instanceof ConfigError && error.code === "IDEMPOTENCY_CONFLICT")
})

test("agent policy, protected values, and secret redaction", async (t) => {
  const db = await store(t)
  db.create({ config: { ...config(), secrets: { "model.apiKey": { env: "OPENAI_API_KEY" } } }, actor: "operator" })
  const allowed = db.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { model: { name: "b" } } })
  assert.equal(allowed.config.model?.name, "b")
  assert.throws(() => db.update("mira", { actor: "agent:mira", expectedRevision: 2, patch: { home: "/bad" } }), /may not edit/)
  const tuned = db.update("mira", { actor: "agent:mira", expectedRevision: 2, patch: { runtime: { contextCompactTriggerTokens: 90_000, contextCompactHardTriggerTokens: 115_000 } } })
  assert.equal(tuned.config.runtime?.contextCompactTriggerTokens, 90_000)
  assert.equal(tuned.config.runtime?.contextCompactHardTriggerTokens, 115_000)
  assert.equal(db.get("mira")!.config.secrets as unknown, "[redacted]")
})

test("seeds are create-only, detect three-way conflicts, and enforce seed paths", async (t) => {
  const db = await store(t)
  const seed = { ...config(), model: { provider: "openai" as const, name: "seed-a" }, configPolicy: { enforcedPaths: ["model.name"] } }
  assert.equal(db.seed({ config: seed, actor: "seed" }).enabled, true)
  db.update("mira", { actor: "operator", expectedRevision: 1, patch: { discord: { enabled: true } } })
  assert.equal(db.seed({ config: { ...seed, model: { provider: "openai" as const, name: "seed-b" } }, actor: "seed" }).revision, 2)
  assert.throws(() => db.update("mira", { actor: "operator", expectedRevision: 2, patch: { model: { name: "no" } } }), /enforced/)
  const conflict = db.previewSeed({ config: { ...seed, discord: { enabled: false } }, actor: "operator", reapply: true, expectedRevision: 2 })
  assert.deepEqual(conflict.conflicts, ["discord.enabled"])
})

test("restart keeps revisions and active application state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-config-store-restart-")); const file = path.join(dir, "config.db")
  const one = new ConfigStore(file); one.create({ config: config(), actor: "operator" }); one.markApplying("mira", 1); one.markActive("mira", 1); one.close()
  const two = new ConfigStore(file); assert.deepEqual(two.get("mira")!.application, { state: "active", desiredRevision: 1, activeRevision: 1 }); two.close()
  await fs.rm(dir, { recursive: true, force: true })
})


test("creation binds enforced policy and seed reapply handles deletion and immutable fields", async (t) => {
  const db = await store(t)
  db.create({ config: { ...config(), model: { provider: "openai", name: "fixed" }, configPolicy: { enforcedPaths: ["model.name"] } }, actor: "operator", seed: true })
  assert.throws(() => db.update("mira", { actor: "operator", expectedRevision: 1, patch: { model: { name: "other" } } }), /enforced/)
  db.seed({ config: { ...config(), discord: { enabled: true } }, actor: "seed", reapply: true, expectedRevision: 1 })
  const deleted = db.seed({ config: config(), actor: "seed", reapply: true, expectedRevision: 2 })
  assert.equal(deleted.config.discord, undefined)
  assert.throws(() => db.seed({ config: { ...config(), home: "/moved" }, actor: "seed", reapply: true, expectedRevision: 3 }), /migration/)
})

test("an agent writes its own posture wording unless the operator pins it", async (t) => {
  const db = await store(t)
  const seeded = {
    ...config(),
    discord: { enabled: true, postures: { hearth: { bio: "around — say hi." } } },
    configPolicy: { enforcedPaths: ["discord.postures.hearth.bio"] },
  }
  db.create({ config: { ...config(), discord: { enabled: true } }, actor: "operator" })
  const own = db.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { discord: { postures: { hearth: { bio: "violet light, warm and steady." } } } } })
  assert.deepEqual(own.config.discord?.postures, { hearth: { bio: "violet light, warm and steady." } })

  const pinned = await store(t)
  pinned.create({ config: seeded, actor: "operator", seed: true })
  assert.throws(
    () => pinned.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { discord: { postures: { hearth: { bio: "mine now" } } } } }),
    (error: unknown) => error instanceof ConfigError && error.code === "POLICY_DENIED",
  )
})

test("a patch names fields by path or by block, and a rejected one teaches its shape", async (t) => {
  const db = await store(t)
  db.create({ config: { ...config(), discord: { enabled: true } }, actor: "operator" })

  const byPath = db.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { "discord.dmWhitelist": "1,2", "discord.postures.hearth.bio": "around" } })
  assert.equal(byPath.config.discord?.dmWhitelist, "1,2")
  assert.deepEqual(byPath.config.discord?.postures, { hearth: { bio: "around" } })
  assert.equal(byPath.config.discord?.enabled, true, "a path edit leaves its neighbours alone")

  const bySecretPath = db.update("mira", { actor: "operator", expectedRevision: 2, patch: { "secrets.model.apiKey": { env: "OPENAI_API_KEY" } } })
  assert.deepEqual(bySecretPath.config.secrets as unknown, "[redacted]")

  assert.throws(
    () => db.update("mira", { actor: "operator", expectedRevision: 3, patch: { config: { model: { name: "b" } } } }),
    /drop the outer "config" wrapper/,
  )
  assert.throws(
    () => db.update("mira", { actor: "operator", expectedRevision: 3, patch: { mood: "violet" } }),
    /discord\.dmWhitelist/,
  )
})
