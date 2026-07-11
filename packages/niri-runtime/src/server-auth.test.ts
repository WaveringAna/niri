import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "./server"

test("worker management routes require bearer auth without permissive CORS", async () => {
  const app = createServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const crossOriginHealth = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })
    assert.equal(crossOriginHealth.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status" })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status", headers: { authorization: "test-worker-token" } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status", headers: { authorization: "Bearer test-worker-token" } })).statusCode, 200)
  } finally {
    await app.close()
  }
})
