import assert from "node:assert/strict"
import test from "node:test"
import { ClientToolBroker } from "./client-broker.js"
import { handleClientBrokerHttpRequest } from "./http-adapter.js"

test("HTTP adapter applies bearer auth and operation-specific error status", async () => {
  const broker = new ClientToolBroker({ agentId: "mira", token: "secret" })
  assert.equal((await handleClientBrokerHttpRequest(broker, "hello", undefined, {})).statusCode, 401)
  assert.equal((await handleClientBrokerHttpRequest(broker, "hello", "secret", {})).statusCode, 401)
  assert.equal((await handleClientBrokerHttpRequest(broker, "hello", "Bearer secret", {})).statusCode, 400)
  assert.equal((await handleClientBrokerHttpRequest(broker, "poll", "Bearer secret", {})).statusCode, 409)
})
