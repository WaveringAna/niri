import assert from "node:assert/strict"
import test from "node:test"
import {
  __mcpTest,
  callMcpTool,
  getMcpToolDefinitions,
  startMcpServers,
  stopMcpServers,
} from "./mcp"

test("MCP stdio servers register namespaced tools and receive calls", async (t) => {
  const serverSource = String.raw`
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool("echo.value", {
      description: "Echo a value",
      inputSchema: { value: z.string() },
    }, async ({ value }) => ({ content: [{ type: "text", text: "echo:" + value }] }));
    await server.connect(new StdioServerTransport());
  `

  t.after(async () => stopMcpServers())
  await startMcpServers({
    fixture: {
      command: process.execPath,
      args: ["--input-type=module", "--eval", serverSource],
    },
  })

  assert.deepEqual(
    getMcpToolDefinitions().map((tool) => tool.function.name),
    ["fixture__echo_value"],
  )
  assert.equal(await callMcpTool("fixture__echo_value", { value: "hello" }), "echo:hello")
})

test("MCP public tool names are bounded and normalized", () => {
  assert.equal(__mcpTest.publicToolName("github", "issues.list"), "github__issues_list")
  assert.throws(() => __mcpTest.publicToolName("server", "x".repeat(64)), /longer than 64/)
})

test("MCP HTTP auth is added without dropping custom headers", () => {
  assert.deepEqual(__mcpTest.httpHeaders({
    url: "https://example.com/mcp",
    headers: { "X-Agent": "mira" },
    auth: { type: "bearer", token: "secret" },
  }), {
    "X-Agent": "mira",
    Authorization: "Bearer secret",
  })
  assert.equal(__mcpTest.httpHeaders({
    url: "https://example.com/mcp",
    auth: { type: "basic", username: "mira", password: "secret" },
  }).Authorization, "Basic bWlyYTpzZWNyZXQ=")
})
