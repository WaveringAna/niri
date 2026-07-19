import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  assertNoDuplicateBridgePorts,
  assertNoDuplicateDiscordTokens,
  buildWorkerEnvironment,
  loadAgentFiles,
  resolveLocalAgents,
} from "./local-agents"

function fixture(t: test.TestContext, files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niri-agents-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents)
  return directory
}

const options = { controlPort: 4300, repoRoot: "/tmp/niri-review" }

test("one yaml file is one complete agent", (t) => {
  const directory = fixture(t, {
    "mira.yaml": `
name: Mira
client: http://mira-macbook.local:3002
model:
  name: openai/gpt-5
  baseUrl: https://openrouter.ai/api/v1
  apiKey: model-secret
  thinking: true
discord:
  token: discord-secret
  enabled: true
webhooks:
  github:
    secret: github-secret
    signatureHeader: x-hub-signature-256
fallback:
  name: local-model
  baseUrl: http://server.local:1234/v1
settings:
  RUNNER_MAX_TURNS: 80
mcp:
  search:
    url: https://mcp.example.com/mcp
    auth:
      type: bearer
      token: mcp-secret
  local:
    command: node
    args: [server.mjs]
    env:
      SERVER_TOKEN: local-secret
`,
  })
  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.id, "mira")
  assert.equal(agent?.name, "Mira")
  assert.equal(agent?.client, "http://mira-macbook.local:3002")
  assert.equal(agent?.settings.MODEL, "openai/gpt-5")
  assert.equal(agent?.settings.OPENAI_API_KEY, "model-secret")
  assert.equal(agent?.settings.DISCORD_BOT_TOKEN, "discord-secret")
  assert.deepEqual(agent?.webhooks, {
    github: { secret: "github-secret", signatureHeader: "x-hub-signature-256" },
  })
  assert.equal(agent?.settings.FALLBACK_MODEL, "local-model")
  assert.equal(agent?.settings.RUNNER_MAX_TURNS, "80")
  assert.deepEqual(JSON.parse(agent?.settings.NIRI_MCP_CONFIG ?? ""), {
    search: {
      url: "https://mcp.example.com/mcp",
      auth: { type: "bearer", token: "mcp-secret" },
    },
    local: {
      command: "node",
      args: ["server.mjs"],
      env: { SERVER_TOKEN: "local-secret" },
    },
  })
})

test("local makes the server machine the client", (t) => {
  const directory = fixture(t, { "local.yaml": "client: local\nmodel:\n  provider: anthropic\n  name: claude\n  apiKey: secret\n" })
  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.client, "local")
  assert.equal(agent?.settings.USE_ANTHROPIC, "true")
  assert.equal(agent?.settings.ANTHROPIC_MODEL, "claude")
})

test("agent identity, ports, and homes stay isolated", (t) => {
  const directory = fixture(t, {
    "a.yaml": "client: local\nport: 4301\nhome: /tmp/shared\n",
    "b.yaml": "client: local\nport: 4301\nhome: /tmp/shared\n",
  })
  assert.throws(() => resolveLocalAgents(loadAgentFiles(directory), options), /share port/)
})

test("worker environment contains only host basics and that agent's yaml settings", (t) => {
  const directory = fixture(t, { "mira.yaml": "client: local\nmodel:\n  name: model\n  apiKey: secret\n" })
  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  const env = buildWorkerEnvironment({ PATH: process.env.PATH, SHOULD_NOT_LEAK: "nope" }, agent!)
  assert.equal(env.PATH, process.env.PATH)
  assert.equal(env.SHOULD_NOT_LEAK, undefined)
  assert.equal(env.OPENAI_API_KEY, "secret")
  assert.equal(env.NIRI_CLIENT, "local")
  assert.equal(env.NIRI_AGENT_ID, "mira")
})

test("unknown and reserved yaml settings fail startup", (t) => {
  const unknown = fixture(t, { "a.yaml": "client: local\nmodle: nope\n" })
  assert.throws(() => loadAgentFiles(unknown), /unknown keys: modle/)

  const reserved = fixture(t, { "a.yaml": "client: local\nsettings:\n  NIRI_HOME: /tmp/escape\n" })
  assert.throws(() => loadAgentFiles(reserved), /NIRI_HOME is managed by the server/)
})

test("MCP transport configuration is strict", (t) => {
  const both = fixture(t, { "a.yaml": "client: local\nmcp:\n  bad:\n    url: https://example.com/mcp\n    command: node\n" })
  assert.throws(() => loadAgentFiles(both), /exactly one of url or command/)

  const commandAuth = fixture(t, { "a.yaml": "client: local\nmcp:\n  bad:\n    command: node\n    auth:\n      type: bearer\n      token: secret\n" })
  assert.throws(() => loadAgentFiles(commandAuth), /headers and auth are only valid with url/)

  const duplicateAuth = fixture(t, { "a.yaml": "client: local\nmcp:\n  bad:\n    url: https:\/\/example.com\/mcp\n    headers:\n      Authorization: secret\n    auth:\n      type: bearer\n      token: secret\n" })
  assert.throws(() => loadAgentFiles(duplicateAuth), /cannot set both auth and an Authorization header/)
})

test("Discord credentials and bridge ports cannot overlap", (t) => {
  const directory = fixture(t, {
    "a.yaml": "client: local\nport: 4301\ndiscord:\n  token: same\nsettings:\n  ANTIGRAVITY_BRIDGE_ENABLED: true\n  ANTIGRAVITY_BRIDGE_PORT: 4400\n",
    "b.yaml": "client: local\nport: 4302\ndiscord:\n  token: same\nsettings:\n  CODEX_BRIDGE_ENABLED: true\n  CODEX_BRIDGE_PORT: 4400\n",
  })
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateDiscordTokens(agents), /share DISCORD_BOT_TOKEN/)
  assert.throws(() => assertNoDuplicateBridgePorts(agents, 4300), /bridges share port 4400/)
})
