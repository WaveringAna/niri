import assert from "node:assert/strict"
import test from "node:test"
import { matchesWorkerIdentity } from "./supervisor"

test("worker health must match the supervised agent and process instance", () => {
  assert.equal(matchesWorkerIdentity({ agentId: "mira", instanceId: "one" }, "mira", "one"), true)
  assert.equal(matchesWorkerIdentity({ agentId: "other", instanceId: "one" }, "mira", "one"), false)
  assert.equal(matchesWorkerIdentity({ agentId: "mira", instanceId: "stale" }, "mira", "one"), false)
})
