import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ConfigStore } from "./control/config-store"
import { AgentManager } from "./agent-manager"

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function eventually(assertion: () => void, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try { assertion(); return } catch (error) { last = error; await pause(25) }
  }
  throw last
}

function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "niri-managed-worker-"))
  const ready = path.join(home, "ready")
  const log = path.join(home, "launches")
  const crash = path.join(home, "crash")
  const applied = path.join(home, "applied")
  fs.writeFileSync(ready, "ready")
  const worker = path.join(home, "worker.mjs")
  fs.writeFileSync(worker, `
import fs from "node:fs";
import http from "node:http";
const env = process.env;
fs.appendFileSync(env.NIRI_TEST_LOG, env.NIRI_CONFIG_REVISION + "\\n");
if (env.NIRI_TEST_FAIL === "true") process.exit(19);
const server = http.createServer((req, res) => {
  if (req.url === "/health") return res.end(JSON.stringify({agentId: env.NIRI_AGENT_ID, instanceId: env.NIRI_WORKER_INSTANCE_ID, configRevision: env.NIRI_CONFIG_REVISION}));
  if (req.url === "/config/application-readiness") {
    const ready = fs.readFileSync(env.NIRI_TEST_READY_FILE, "utf8").trim() === "ready";
    return res.end(JSON.stringify({safeToApply: ready, ready, liveHostRpcLeases: ready ? 0 : 1, loopIdle: ready, configRevision: env.NIRI_CONFIG_REVISION}));
  }
  if (req.url === "/config/apply" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const keys = Object.keys(payload.settings ?? {});
      for (const [key, value] of Object.entries(payload.settings ?? {})) { if (value === null) delete env[key]; else env[key] = value; }
      env.NIRI_CONFIG_REVISION = String(payload.revision);
      fs.appendFileSync(env.NIRI_TEST_APPLY_LOG, keys.sort().join(",") + "\\n");
      const applied = env.NIRI_TEST_PARTIAL_APPLY === "true" ? keys.slice(0, keys.length - 1) : keys;
      res.end(JSON.stringify({applied, configRevision: env.NIRI_CONFIG_REVISION}));
    });
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(Number(env.PORT), "127.0.0.1", () => {
  if (env.NIRI_TEST_CRASH_ONCE === "true" && !fs.existsSync(env.NIRI_TEST_CRASH_FILE)) {
    fs.writeFileSync(env.NIRI_TEST_CRASH_FILE, "used"); setTimeout(() => process.exit(9), 80);
  }
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`)
  const store = new ConfigStore(path.join(home, "control.db"))
  const registrations: string[] = []
  const manager = new AgentManager({
    store, repoRoot: home, workerEntry: worker, controlPort: 47000 + Math.floor(Math.random() * 1000), controlHome: home,
    configServerUrl: "http://127.0.0.1:1", agentToken: () => "test-token",
    registerAgent: ({ id }) => registrations.push(id), removeAgent: (id) => registrations.push(`-${id}`),
  })
  t.after(async () => { await manager.close(); store.close(); fs.rmSync(home, { recursive: true, force: true }) })
  return { home, ready, log, crash, applied, store, manager, registrations }
}

function create(f: ReturnType<typeof fixture>, settings: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return f.store.create({ actor: "operator", enabled: true, config: { id: "mira", settings: { NIRI_TEST_READY_FILE: f.ready, NIRI_TEST_LOG: f.log, NIRI_TEST_CRASH_FILE: f.crash, NIRI_TEST_APPLY_LOG: f.applied, ...settings }, ...extra } })
}
function launches(file: string): string[] { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [] }

test("self edit waits for idle readiness then applies its revision", async (t) => {
  const f = fixture(t); create(f); f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))
  fs.writeFileSync(f.ready, "busy")
  f.store.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { model: { name: "changed" } } })
  f.manager.schedule("mira")
  await pause(150); assert.equal(f.store.get("mira")?.application.state, "pending")
  fs.writeFileSync(f.ready, "ready")
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 2))
  assert.deepEqual(launches(f.log), ["1", "2"])
})

test("rapid edits start only the latest revision", async (t) => {
  const f = fixture(t); create(f); f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))
  fs.writeFileSync(f.ready, "busy")
  for (const revision of [1, 2]) {
    f.store.update("mira", { actor: "operator", expectedRevision: revision, patch: { settings: { NIRI_TEST_READY_FILE: f.ready, NIRI_TEST_LOG: f.log, NIRI_TEST_CRASH_FILE: f.crash, MARK: String(revision) } } })
    f.manager.schedule("mira")
  }
  fs.writeFileSync(f.ready, "ready")
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 3))
  assert.deepEqual(launches(f.log), ["1", "3"])
})

test("failed first boot does not retry, while a post-health crash recovers", async (t) => {
  const failed = fixture(t); create(failed, { NIRI_TEST_FAIL: "true" }); failed.manager.startEnabled()
  await eventually(() => assert.equal(failed.store.get("mira")?.application.state, "failed"))
  await pause(250)
  assert.deepEqual(launches(failed.log), ["1"])

  const recovered = fixture(t); create(recovered, { NIRI_TEST_CRASH_ONCE: "true" }); recovered.manager.startEnabled()
  await eventually(() => assert.ok(launches(recovered.log).length >= 2), 4_000)
  await eventually(() => assert.equal(recovered.store.get("mira")?.application.activeRevision, 1))
  assert.ok(recovered.registrations.includes("-mira"))
})

test("operator stop during readiness wait cannot respawn the pending revision", async (t) => {
  const f = fixture(t); create(f); f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))
  fs.writeFileSync(f.ready, "busy")
  f.store.update("mira", { actor: "operator", expectedRevision: 1, patch: { settings: { NIRI_TEST_READY_FILE: f.ready, NIRI_TEST_LOG: f.log, NIRI_TEST_CRASH_FILE: f.crash } } })
  f.manager.schedule("mira")
  await pause(80); await f.manager.stop("mira")
  fs.writeFileSync(f.ready, "ready")
  await pause(350)
  assert.equal(f.store.get("mira")?.enabled, false)
  assert.deepEqual(launches(f.log), ["1"])
})

test("a hot setting reaches the running worker without replacing it", async (t) => {
  const f = fixture(t)
  create(f, {}, { discord: { dmWhitelist: "1" } })
  f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))

  f.store.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { "discord.dmWhitelist": "1,2" } })
  f.manager.schedule("mira")
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 2))
  assert.deepEqual(launches(f.log), ["1"], "the worker was never replaced")
  assert.deepEqual(launches(f.applied), ["DISCORD_DM_WHITELIST"])
  assert.equal(f.store.get("mira")?.application.state, "active")
})

test("a control-plane webhook revision activates without replacing the worker", async (t) => {
  const f = fixture(t)
  create(f, {}, { configPolicy: { agentWebhooks: true } })
  f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))

  const provisioned = f.store.provisionWebhook("mira", { actor: "agent:mira", name: "deploy", expectedRevision: 1, idempotencyKey: "deploy-hook" })
  f.manager.refresh("mira")
  assert.equal(f.manager.webhooks.get("mira")?.deploy?.secret, provisioned.secret, "webhook routing refreshes before reconciliation")

  f.store.update("mira", { actor: "operator", expectedRevision: 2, patch: { webhooks: { deploy: { secret: "rotated-secret", signatureHeader: "x-rotated-signature" } } } })
  f.manager.refresh("mira")
  assert.deepEqual(f.manager.webhooks.get("mira")?.deploy, { secret: "rotated-secret", signatureHeader: "x-rotated-signature" }, "operator rotation replaces routing synchronously")

  f.store.rollback("mira", 1, { actor: "operator", expectedRevision: 3 })
  f.manager.refresh("mira")
  assert.equal(f.manager.webhooks.get("mira")?.deploy, undefined, "operator rollback revokes routing synchronously")
  f.manager.schedule("mira")
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 4))
  assert.deepEqual(launches(f.log), ["1"], "control-plane-only config does not replace the worker")
  assert.equal(f.store.get("mira")?.application.state, "active")
})

test("an unclassified setting still replaces the worker", async (t) => {
  const f = fixture(t)
  create(f, {}, { discord: { dmWhitelist: "1" } })
  f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))

  // NIRI_TEST_UNCLASSIFIED is in nobody's hot list, so the revision costs a restart.
  f.store.update("mira", {
    actor: "operator", expectedRevision: 1,
    patch: { settings: { NIRI_TEST_READY_FILE: f.ready, NIRI_TEST_LOG: f.log, NIRI_TEST_CRASH_FILE: f.crash, NIRI_TEST_APPLY_LOG: f.applied, NIRI_TEST_UNCLASSIFIED: "x" } },
  })
  f.manager.schedule("mira")
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 2))
  assert.deepEqual(launches(f.log), ["1", "2"])
  assert.deepEqual(launches(f.applied), [], "no live apply was attempted")
})

test("a partial apply fails the revision and names what is missing", async (t) => {
  const f = fixture(t)
  create(f, { NIRI_TEST_PARTIAL_APPLY: "true" }, { discord: { dmWhitelist: "1", scanChannelIds: "9" } })
  f.manager.startEnabled()
  await eventually(() => assert.equal(f.store.get("mira")?.application.activeRevision, 1))

  f.store.update("mira", { actor: "agent:mira", expectedRevision: 1, patch: { discord: { dmWhitelist: "1,2", scanChannelIds: "9,10" } } })
  f.manager.schedule("mira")
  await eventually(() => {
    const view = f.store.get("mira")
    assert.equal(view?.application.state, "failed")
    assert.match(view?.application.error ?? "", /missing DISCORD_SCAN_CHANNEL_IDS/)
  })
  assert.deepEqual(launches(f.log), ["1"], "a partial apply is reported, not papered over with a restart")
})
