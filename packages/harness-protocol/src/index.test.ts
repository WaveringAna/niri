import assert from "node:assert/strict"
import test from "node:test"
import {
  parseClientHello,
  parseClientLease,
  parseClientPollResponse,
  parseClientToolResult,
} from "./index.js"

test("client hello validates identities and de-duplicates capabilities", () => {
  assert.equal(parseClientHello({}), null)
  const hello = parseClientHello({
    protocol: "harness-tool/v1",
    agentId: "mira",
    clientId: "mira-macbook",
    capabilities: ["shell", "shell", "read_file"],
    workspace: { id: "mira", root: "/Users/mira/project" },
  })
  assert.deepEqual(hello?.capabilities, ["shell", "read_file"])
})

test("wire parsers reject unknown tools, array args, and malformed dates", () => {
  assert.equal(parseClientLease({ agentId: "a", clientId: "c", leaseId: "l", expiresAt: "not-a-date" }), null)
  assert.equal(
    parseClientPollResponse({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      clientId: "c",
      leaseId: "l",
      tool: "server_shell",
      args: {},
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
  assert.equal(
    parseClientPollResponse({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      clientId: "c",
      leaseId: "l",
      tool: "shell",
      args: [],
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
})

test("tool result image metadata must match a bounded image data URL shape", () => {
  const base = {
    type: "tool.result",
    invocationId: "i",
    agentId: "a",
    clientId: "c",
    leaseId: "l",
    status: "ok",
    completedAt: new Date().toISOString(),
  }
  assert.equal(
    parseClientToolResult({
      ...base,
      image: { path: "x", mime: "text/plain", bytes: -1, dataUrl: "data:text/plain;base64,eA==" },
    }),
    null,
  )
  assert.equal(
    parseClientToolResult({
      ...base,
      image: { path: "x.png", mime: "image/png", bytes: 1, dataUrl: "data:image/png;base64,eA==" },
    })?.image?.mime,
    "image/png",
  )
})
