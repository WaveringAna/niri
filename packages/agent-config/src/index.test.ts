import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { agentSettings, parseAgentFile } from "./index.js"

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
