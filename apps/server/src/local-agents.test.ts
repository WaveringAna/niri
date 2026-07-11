import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  assertNoDuplicateBridgePorts,
  assertNoDuplicateDiscordTokens,
  buildWorkerEnvironment,
  parseLocalAgents,
  resolveLocalAgents,
} from "./local-agents"

const options = {
  controlPort: 4300,
  repoRoot: "/tmp/niri-review",
  token: (() => {
    let index = 0
    return () => `generated-${++index}`
  })(),
}

test("multi-agent configuration rejects shared identity, port, home, and client tokens", () => {
  assert.throws(
    () => resolveLocalAgents([{ id: "same" }, { id: "same" }], options),
    /share id/,
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", port: 4301 }, { id: "b", port: 4301 }], options),
    /share port/,
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", home: "/tmp/shared" }, { id: "b", home: "/tmp/shared" }], options),
    /share home/,
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", toolClientToken: "shared" }, { id: "b", toolClientToken: "shared" }], options),
    /reuse a credential/,
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", workerToken: "shared" }, { id: "b", toolClientToken: "shared" }], options),
    /reuse a credential/,
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", workerToken: "do-not-log" }, { id: "b", workerToken: "do-not-log" }], options),
    (error: unknown) => error instanceof Error && !error.message.includes("do-not-log"),
  )
  assert.throws(
    () => resolveLocalAgents([{ id: "a", toolClientToken: "control-secret" }], { ...options, controlToken: "control-secret" }),
    /control and agent credentials must be distinct/,
  )
})

test("home uniqueness follows filesystem aliases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niri-home-alias-"))
  const real = path.join(root, "real")
  const alias = path.join(root, "alias")
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => resolveLocalAgents([{ id: "a", home: real }, { id: "b", home: alias }], options),
    /share home/,
  )
})

test("explicit multi-agent workers do not inherit control-plane or sibling secrets", () => {
  const parent = {
    PATH: process.env.PATH,
    NIRI_LOCAL_AGENTS_JSON: JSON.stringify([
      { id: "alpha", toolClientToken: "alpha-secret" },
      { id: "beta", toolClientToken: "beta-secret" },
    ]),
    NIRI_TOOL_CLIENT_TOKEN: "global-secret",
    NIRI_CONTROL_TOKEN: "control-secret",
    NIRI_AGENT_STATE_DIR: "/tmp/shared-state",
    OPENAI_API_KEY: "provider-secret",
  }
  const agents = resolveLocalAgents(parseLocalAgents(parent, 4300), options)
  const alpha = buildWorkerEnvironment(parent, agents[0]!)

  assert.equal(alpha.NIRI_TOOL_CLIENT_TOKEN, "alpha-secret")
  assert.equal(alpha.NIRI_LOCAL_AGENTS_JSON, undefined)
  assert.equal(alpha.NIRI_CONTROL_TOKEN, undefined)
  assert.equal(alpha.NIRI_AGENT_STATE_DIR, undefined)
  assert.equal(alpha.OPENAI_API_KEY, "provider-secret")
  assert.equal(alpha.NIRI_HOME, path.join(fs.realpathSync("/tmp"), "niri-review", "data", "agents", "alpha"))
  assert.equal(alpha.NIRI_WORKER_HOST, "127.0.0.1")
  assert.equal(alpha.HOME, alpha.NIRI_HOME)
  assert.equal(alpha.NIRI_MIGRATE_LEGACY_STATE, "false")
})

test("reserved lifecycle variables cannot hide inside an agent env object", () => {
  assert.throws(
    () => parseLocalAgents({ NIRI_LOCAL_AGENTS_JSON: '[{"id":"a","env":{"NIRI_HOME":"/tmp/escape"}}]' }, 4300),
    /NIRI_HOME is reserved/,
  )
  assert.throws(
    () => parseLocalAgents({ NIRI_LOCAL_AGENTS_JSON: '[{"id":"a","toolClientTokn":"typo"}]' }, 4300),
    /unknown keys: toolClientTokn/,
  )
})

test("Discord and Antigravity endpoints cannot overlap across agents", () => {
  const agents = resolveLocalAgents([
    { id: "a", port: 4301, env: { DISCORD_BOT_TOKEN: "same", ANTIGRAVITY_BRIDGE_ENABLED: "true", ANTIGRAVITY_BRIDGE_PORT: "4302" } },
    { id: "b", port: 4302, env: { DISCORD_BOT_TOKEN: " same " } },
  ], options)

  assert.throws(() => assertNoDuplicateDiscordTokens(agents, {}), /share DISCORD_BOT_TOKEN/)
  assert.throws(() => assertNoDuplicateBridgePorts(agents, {}, 4300), /conflicts with worker b/)
})

test("Codex and Antigravity bridge ports cannot overlap", () => {
  const agents = resolveLocalAgents([
    { id: "a", port: 4301, env: { ANTIGRAVITY_BRIDGE_ENABLED: "true", ANTIGRAVITY_BRIDGE_PORT: "4400" } },
    { id: "b", port: 4302, env: { CODEX_BRIDGE_ENABLED: "true", CODEX_BRIDGE_PORT: "4400" } },
  ], options)
  assert.throws(() => assertNoDuplicateBridgePorts(agents, {}, 4300), /a Antigravity and b Codex bridges share port 4400/)
})
