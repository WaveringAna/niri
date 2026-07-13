import assert from "node:assert/strict"
import test from "node:test"
import { createControlServer } from "./server"
import { initControlDb } from "./db"

test("control routes need no bearer token and do not enable permissive CORS", async () => {
  initControlDb()
  const app = createControlServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const agents = await app.inject({ method: "GET", url: "/agents" })
    assert.equal(agents.statusCode, 200)
    assert.equal(agents.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/unknown" })).statusCode, 404)
  } finally {
    await app.close()
  }
})
