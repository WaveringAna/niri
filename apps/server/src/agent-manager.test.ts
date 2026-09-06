import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ConfigStore } from "./control/config-store"
import { AgentManager } from "./agent-manager"

function temporary(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niri-manager-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("new durable agents stay stopped and retain their allocated port", async (t) => {
  const home = temporary(t)
  const store = new ConfigStore(path.join(home, "control.db"))
  t.after(() => store.close())
  const manager = new AgentManager({
    store, repoRoot: home, workerEntry: "worker.ts", controlPort: 4300, controlHome: home,
    configServerUrl: "http://127.0.0.1:4300", agentToken: () => "token",
  })
  store.setValidator((config, id) => manager.validate(config, id))
  store.create({ actor: "operator", config: { id: "mira" } })
  const [mira] = manager.list()
  assert.equal(mira?.enabled, false)
  assert.equal(mira?.running, false)
  // Validation is pure. A rejected/pre-start candidate cannot poison durable
  // allocation state; allocation is recorded only by reconciliation/spawn.
  assert.equal(fs.existsSync(path.join(home, "agent-ports.json")), false)
  manager.validate(store.getRaw("mira")!, "mira")
  assert.equal(fs.existsSync(path.join(home, "agent-ports.json")), false)
  manager.schedule("mira")
  await new Promise<void>((resolve) => setImmediate(resolve))
  const allocation = JSON.parse(fs.readFileSync(path.join(home, "agent-ports.json"), "utf8")) as Record<string, { worker: number }>
  assert.equal(allocation.mira?.worker, 4301)
})

test("fleet validation rejects a worker port collision before commit", (t) => {
  const home = temporary(t)
  const store = new ConfigStore(path.join(home, "control.db"))
  t.after(() => store.close())
  const manager = new AgentManager({ store, repoRoot: home, workerEntry: "worker.ts", controlPort: 4300, controlHome: home, configServerUrl: "http://127.0.0.1:4300", agentToken: () => "token" })
  store.setValidator((config, id) => manager.validate(config, id))
  store.create({ actor: "operator", config: { id: "mira", port: 4301 } })
  assert.throws(() => store.create({ actor: "operator", config: { id: "lyra", port: 4301 } }), /share worker port/)
})


test("legacy import reserves the original separate iroh tunnel range", (t) => {
  const home = temporary(t)
  const store = new ConfigStore(path.join(home, "control.db"))
  t.after(() => store.close())
  const manager = new AgentManager({ store, repoRoot: home, workerEntry: "worker.ts", controlPort: 4300, controlHome: home, configServerUrl: "http://127.0.0.1:4300", agentToken: () => "token" })
  manager.reserveLegacy([
    { id: "local", name: "local", port: 4301, home: path.join(home, "local"), client: "local", workerMode: "local", settings: {}, webhooks: {}, source: "legacy" },
    { id: "iroh", name: "iroh", port: 4302, clientTunnelPort: 4304, home: path.join(home, "iroh"), client: "iroh", workerMode: "local", settings: {}, webhooks: {}, source: "legacy" },
  ])
  const ports = JSON.parse(fs.readFileSync(path.join(home, "agent-ports.json"), "utf8")) as Record<string, { worker: number; tunnel?: number }>
  assert.deepEqual(ports, { local: { worker: 4301 }, iroh: { worker: 4302, tunnel: 4304 } })
})
