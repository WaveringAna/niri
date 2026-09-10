import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { agentSettings, isAllowedConfigPath, isProtectedConfigPath, parseAgentConfig, parseAgentFile, resolveAgentSecrets } from "./index.js"

async function withYaml(yaml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-agent-config-"))
  const file = path.join(dir, "mira.yaml")
  await fs.writeFile(file, yaml)
  return file
}

test("parseAgentFile accepts server.iroh and worker.mode blocks", async (t) => {
  const file = await withYaml(`
client: local
worker:
  mode: remote
server:
  iroh:
    ticket: base32ticket
    token: sekrit
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  const config = parseAgentFile(file)
  assert.equal(config.worker?.mode, "remote")
  assert.deepEqual(config.server?.iroh, { ticket: "base32ticket", token: "sekrit" })
})

test("parseAgentFile rejects unknown server.iroh keys and bad worker modes", async (t) => {
  const badKey = await withYaml(`
client: local
server:
  iroh:
    ticket: base32ticket
    token: sekrit
    extra: nope
`)
  const badMode = await withYaml(`
client: local
worker:
  mode: sideways
`)
  t.after(() => Promise.all([badKey, badMode].map((file) => fs.rm(path.dirname(file), { recursive: true, force: true }))))

  assert.throws(() => parseAgentFile(badKey), /unknown keys/)
  assert.throws(() => parseAgentFile(badMode), /mode/)
})

test("agentSettings flattens server.iroh into worker dial-out env keys", async (t) => {
  const file = await withYaml(`
client: local
model:
  provider: openai
  name: gpt-test
  baseUrl: http://localhost:1234
  apiKey: key-1
server:
  iroh:
    ticket: base32ticket
    token: sekrit
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  const settings = agentSettings(parseAgentFile(file))
  assert.equal(settings.NIRI_SERVER_IROH_TICKET, "base32ticket")
  assert.equal(settings.NIRI_SERVER_IROH_TOKEN, "sekrit")
  assert.equal(settings.OPENAI_API_KEY, "key-1")
  assert.equal(settings.MODEL, "gpt-test")
})

test("agentSettings exposes the lcm summary batch size", async (t) => {
  const file = await withYaml(`
client: local
runtime:
  lcmSummaryBatchSize: 4
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  const settings = agentSettings(parseAgentFile(file))
  assert.equal(settings.LCM_SUMMARY_BATCH_SIZE, "4")
})

test("agentSettings exposes Discord posture bypass ids", async (t) => {
  const file = await withYaml(`
client: local
discord:
  posture_bypass:
    users:
      - "250140413774659587"
      - "1497041312061329618"
    channels:
      - "1497733589545123981"
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  const config = parseAgentFile(file)
  assert.deepEqual(config.discord?.posture_bypass, {
    users: ["250140413774659587", "1497041312061329618"],
    channels: ["1497733589545123981"],
  })
  assert.equal(
    agentSettings(config).DISCORD_POSTURE_BYPASS,
    JSON.stringify({
      users: ["250140413774659587", "1497041312061329618"],
      channels: ["1497733589545123981"],
    }),
  )
})

test("agentSettings exposes delegation profiles and the Gastown forum", async (t) => {
  const file = await withYaml(`
client: local
discord:
  gastownForumChannelId: "123456789012345678"
delegation:
  enabled: true
  maxConcurrent: 2
  timeoutMs: 1800000
  resultMaxChars: 6000
  profiles:
    - name: researcher
      model: gpt-5.6-luna
      systemPrompt: inspect first and report evidence
      tools: [shell, read_file]
      mcpTools: [web_extract__web_search, web_extract__web_summarize, web_extract__web_preview, web_extract__web_extract]
      maxTurns: 30
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  const config = parseAgentFile(file)
  assert.equal(config.discord?.gastownForumChannelId, "123456789012345678")
  assert.deepEqual(config.delegation?.profiles, [{
    name: "researcher",
    model: "gpt-5.6-luna",
    systemPrompt: "inspect first and report evidence",
    tools: ["shell", "read_file"],
    mcpTools: [
      "web_extract__web_search",
      "web_extract__web_summarize",
      "web_extract__web_preview",
      "web_extract__web_extract",
    ],
    maxTurns: 30,
  }])
  const settings = agentSettings(config)
  assert.equal(settings.DISCORD_GASTOWN_FORUM_CHANNEL_ID, "123456789012345678")
  assert.deepEqual(JSON.parse(settings.NIRI_DELEGATION_CONFIG ?? ""), config.delegation)
})

test("delegation profiles require explicit client-tool allowlists", async (t) => {
  const file = await withYaml(`
client: local
delegation:
  profiles:
    - name: everything
      tools: []
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  assert.throws(() => parseAgentFile(file), /non-empty array/)
})

test("delegation coder profiles accept write_file alongside shell and edits", async (t) => {
  const file = await withYaml(`
client: local
delegation:
  profiles:
    - name: coder
      tools: [shell, read_file, write_file, edit_file]
`)
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }))

  assert.deepEqual(parseAgentFile(file).delegation?.profiles[0]?.tools, [
    "shell",
    "read_file",
    "write_file",
    "edit_file",
  ])
})


test("parseAgentConfig is YAML-independent and secrets resolve only through explicit references", () => {
  const config = parseAgentConfig({
    id: "draft", client: "local", model: { provider: "openai", name: "test" },
    secrets: { "model.apiKey": { env: "TEST_NIRI_KEY" }, "discord.token": { file: "/missing" } },
  })
  const resolved = resolveAgentSecrets(config, { TEST_NIRI_KEY: "key-from-env" })
  assert.equal(resolved.model?.apiKey, "key-from-env")
  assert.equal(resolveAgentSecrets(parseAgentConfig({ id: "explicit", model: { apiKey: "operator-key" }, secrets: { "model.apiKey": { env: "TEST_NIRI_KEY" } } }), { TEST_NIRI_KEY: "other" }).model?.apiKey, "operator-key")
  assert.equal(resolved.discord?.token, undefined)
  assert.equal(resolved.secrets, undefined)
  const webhooks = parseAgentConfig({ webhooks: { deploy: {} }, secrets: { "webhooks.deploy.secret": { env: "TEST_NIRI_KEY" } } })
  assert.equal(resolveAgentSecrets(webhooks, { TEST_NIRI_KEY: "hook-key" }).webhooks?.deploy.secret, "hook-key")
  assert.throws(() => parseAgentConfig({ model: { apiKey: "[redacted]" } }), /redacted/)
  assert.throws(() => parseAgentConfig({ discord: { token: "[redacted]" } }), /redacted/)
  assert.throws(() => parseAgentConfig({ mcp: { remote: { url: "https://example.test", auth: { type: "bearer", token: "[redacted]" } } } }), /redacted/)
  assert.throws(() => parseAgentConfig({ client: "local", __proto__: { poisoned: true } }), /(unsafe keys|custom prototype)/)
})

test("posture wording round-trips through the config into DISCORD_POSTURES", () => {
  const config = parseAgentConfig({
    id: "mira",
    client: "local",
    discord: {
      enabled: true,
      postures: {
        hearth: { description: "warm and open.", guidance: "use it when someone needs you.", bio: "around — say hi." },
        "deep-focus": { bio: "away, building." },
      },
    },
  })

  assert.deepEqual(config.discord?.postures, {
    hearth: { description: "warm and open.", guidance: "use it when someone needs you.", bio: "around — say hi." },
    "deep-focus": { bio: "away, building." },
  })
  assert.deepEqual(JSON.parse(agentSettings(config).DISCORD_POSTURES!), config.discord?.postures)
})

test("posture wording rejects unknown fields, bad names, empty text, and novels", () => {
  const discord = (postures: unknown) => () => parseAgentConfig({ id: "mira", client: "local", discord: { postures } })
  assert.throws(discord({ hearth: { mood: "violet" } }), /unknown keys: mood/)
  assert.throws(discord({ "Hearth!": { bio: "hi" } }), /must match/)
  assert.throws(discord({ hearth: { bio: "   " } }), /non-empty string/)
  assert.throws(discord({ hearth: { bio: "x".repeat(2001) } }), /at most 2000 characters/)
  assert.throws(discord({ hearth: "just a string" }), /must be an object/)
  assert.equal(parseAgentConfig({ id: "mira", client: "local", discord: { postures: {} } }).discord?.postures, undefined)
})

test("an agent may write its own posture wording but never a secret path", () => {
  assert.equal(isAllowedConfigPath(undefined, "discord.postures.hearth.bio"), true)
  assert.equal(isProtectedConfigPath("discord.postures.hearth.bio"), false)
  assert.equal(isAllowedConfigPath({ selfEdit: true, allowedPaths: ["model"] }, "discord.postures.hearth.bio"), false)
  assert.equal(isAllowedConfigPath({ selfEdit: false, allowedPaths: ["discord"] }, "discord.postures.hearth.bio"), false)
  assert.equal(isAllowedConfigPath(undefined, "discord.token"), false)
  assert.equal(parseAgentConfig({ id: "niri" }).configPolicy.agentWebhooks, false)
  assert.equal(parseAgentConfig({ id: "niri", configPolicy: { agentWebhooks: true } }).configPolicy.agentWebhooks, true)
})
