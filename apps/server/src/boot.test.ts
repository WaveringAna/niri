import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import test from "node:test"
import { startControlPlane } from "./boot"
import { getOrCreateToken } from "./control/config-auth"

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

test("startControlPlane serves a fresh install and stops cleanly", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "niri-boot-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const agents = path.join(home, "agents")
  fs.mkdirSync(agents)
  const controlHome = path.join(home, "control")
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const plane = await startControlPlane({ port, host: "127.0.0.1", agentsDirectory: agents, controlHome, controlDb: path.join(controlHome, "control.db") })
  t.after(() => plane.close())

  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)

  const token = getOrCreateToken(path.join(controlHome, "admin.token"))
  const listed = await fetch(`${base}/agents`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json() as { agents: unknown[] }).agents, [])

  const created = await fetch(`${base}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "nova" }) })
  assert.equal(created.status, 201)
  const denied = await fetch(`${base}/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nope" }) })
  assert.equal(denied.status, 403)

  await plane.close()
  await assert.rejects(() => fetch(`${base}/health`), /fetch failed/)
})
