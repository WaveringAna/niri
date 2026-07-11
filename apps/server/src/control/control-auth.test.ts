import assert from "node:assert/strict"
import test from "node:test"
import { createControlServer } from "./server"

test("control token protects management routes while health stays public", async () => {
  const app = createControlServer({ token: "control-secret" })
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    assert.equal((await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })).headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/agents" })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/unknown", headers: { authorization: "Bearer wrong" } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/unknown", headers: { authorization: "Bearer control-secret" } })).statusCode, 404)
  } finally {
    await app.close()
  }
})

test("control server rejects an empty token", () => {
  assert.throws(() => createControlServer({ token: "  " }), /control token is required/)
})
