import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "./server"

test("worker routes need no bearer token and do not enable permissive CORS", async () => {
  const app = createServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const crossOriginHealth = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })
    assert.equal(crossOriginHealth.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status" })).statusCode, 200)
  } finally {
    await app.close()
  }
})
