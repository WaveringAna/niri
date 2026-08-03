import assert from "node:assert/strict"
import test from "node:test"
import {
  parseClientToolResult,
  parseToolInvocation,
} from "./index.js"

test("wire parsers reject unknown tools, array args, and malformed dates", () => {
  assert.equal(
    parseToolInvocation({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      tool: "server_shell",
      args: {},
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
  assert.equal(
    parseToolInvocation({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      tool: "shell",
      args: [],
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
})

test("wire parser accepts write_file invocations", () => {
  const parsed = parseToolInvocation({
    type: "tool.call",
    invocationId: "write-1",
    agentId: "niri",
    tool: "write_file",
    args: { path: "new.md", content: "hello" },
    issuedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 1_000).toISOString(),
  })
  assert.equal(parsed?.tool, "write_file")
})

test("tool result image metadata must match a bounded image data URL shape", () => {
  const base = {
    type: "tool.result",
    invocationId: "i",
    agentId: "a",
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
