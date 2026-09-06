import assert from "node:assert/strict"
import test from "node:test"
import { createServer, discordBatchEnabled } from "./server"
import { issueHostRpcGrant, revokeHostRpcGrant } from "./host-rpc"
import { onSettingsChanged } from "./settings-apply"

test("disabled Discord configuration remains disabled with an inherited token", () => {
  assert.equal(discordBatchEnabled({ DISCORD_GATEWAY_ENABLED: "false", DISCORD_BOT_TOKEN: "inherited-token" }), false)
  assert.equal(discordBatchEnabled({ DISCORD_GATEWAY_ENABLED: "0", DISCORD_BOT_TOKEN: "inherited-token" }), false)
  assert.equal(discordBatchEnabled({ DISCORD_GATEWAY_ENABLED: "no", DISCORD_BOT_TOKEN: "inherited-token" }), false)
  assert.equal(discordBatchEnabled({ DISCORD_BOT_TOKEN: "inherited-token" }), true)
  assert.equal(discordBatchEnabled({ DISCORD_GATEWAY_ENABLED: "true" }), false)
})

test("worker routes need no bearer token and do not enable permissive CORS", async () => {
  const app = createServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const crossOriginHealth = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })
    assert.equal(crossOriginHealth.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status" })).statusCode, 200)
  } finally {
    await app.close()
  }
})


test("config application readiness is scoped, revisioned, and waits for active Python grants", async () => {
  const priorToken = process.env.NIRI_CONFIG_TOKEN
  const priorRevision = process.env.NIRI_CONFIG_REVISION
  process.env.NIRI_CONFIG_TOKEN = "scoped-config-token"
  process.env.NIRI_CONFIG_REVISION = "7"
  const app = createServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/config/application-readiness" })).statusCode, 401)
    const idle = await app.inject({ method: "GET", url: "/config/application-readiness", headers: { authorization: "Bearer scoped-config-token" } })
    assert.equal(idle.statusCode, 200)
    assert.equal(idle.json().configRevision, "7")
    const grant = issueHostRpcGrant("outer", new Date(Date.now() + 5_000).toISOString())
    const busy = await app.inject({ method: "GET", url: "/config/application-readiness", headers: { authorization: "Bearer scoped-config-token" } })
    assert.equal(busy.json().liveHostRpcLeases, 1)
    assert.equal(busy.json().safeToApply, false)
    revokeHostRpcGrant(grant)
  } finally {
    await app.close()
    if (priorToken === undefined) delete process.env.NIRI_CONFIG_TOKEN
    else process.env.NIRI_CONFIG_TOKEN = priorToken
    if (priorRevision === undefined) delete process.env.NIRI_CONFIG_REVISION
    else process.env.NIRI_CONFIG_REVISION = priorRevision
  }
})

test("live apply writes the settings, runs its hooks, and refuses under a python grant", async () => {
  const priorToken = process.env.NIRI_CONFIG_TOKEN
  const priorRevision = process.env.NIRI_CONFIG_REVISION
  const priorWhitelist = process.env.DISCORD_DM_WHITELIST
  process.env.NIRI_CONFIG_TOKEN = "apply-token"
  process.env.NIRI_CONFIG_REVISION = "3"
  process.env.DISCORD_DM_WHITELIST = "1"
  const priorTz = process.env.COOLDOWN_TZ
  process.env.COOLDOWN_TZ = "America/New_York"
  const seen: string[][] = []
  const release = onSettingsChanged(["DISCORD_DM_WHITELIST"], (changed) => { seen.push([...changed].sort()) })
  const app = createServer()
  const post = (settings: unknown, revision = 4) =>
    app.inject({ method: "POST", url: "/config/apply", headers: { authorization: "Bearer apply-token" }, payload: { revision, settings } })
  try {
    assert.equal((await app.inject({ method: "POST", url: "/config/apply", payload: { settings: {} } })).statusCode, 401)
    assert.equal((await post("nope")).statusCode, 400)
    assert.equal((await post({ "bad key": "x" })).statusCode, 400)

    const applied = await post({ DISCORD_DM_WHITELIST: "1,2", COOLDOWN_TZ: null })
    assert.equal(applied.statusCode, 200)
    assert.deepEqual(applied.json().applied.sort(), ["COOLDOWN_TZ", "DISCORD_DM_WHITELIST"])
    assert.equal(process.env.DISCORD_DM_WHITELIST, "1,2")
    assert.equal("COOLDOWN_TZ" in process.env, false)
    assert.equal(applied.json().configRevision, "4")
    assert.deepEqual(seen, [["COOLDOWN_TZ", "DISCORD_DM_WHITELIST"]])

    const grant = issueHostRpcGrant("outer", new Date(Date.now() + 5_000).toISOString())
    const busy = await post({ DISCORD_DM_WHITELIST: "1,2,3" }, 5)
    revokeHostRpcGrant(grant)
    assert.equal(busy.statusCode, 409)
    assert.equal(process.env.DISCORD_DM_WHITELIST, "1,2", "a busy worker keeps the settings it is running on")
    assert.equal(process.env.NIRI_CONFIG_REVISION, "4")
  } finally {
    release()
    await app.close()
    if (priorToken === undefined) delete process.env.NIRI_CONFIG_TOKEN; else process.env.NIRI_CONFIG_TOKEN = priorToken
    if (priorRevision === undefined) delete process.env.NIRI_CONFIG_REVISION; else process.env.NIRI_CONFIG_REVISION = priorRevision
    if (priorWhitelist === undefined) delete process.env.DISCORD_DM_WHITELIST; else process.env.DISCORD_DM_WHITELIST = priorWhitelist
    if (priorTz === undefined) delete process.env.COOLDOWN_TZ; else process.env.COOLDOWN_TZ = priorTz
  }
})

test("a hook that throws makes the apply fail instead of half-landing quietly", async () => {
  const priorToken = process.env.NIRI_CONFIG_TOKEN
  process.env.NIRI_CONFIG_TOKEN = "apply-token"
  const release = onSettingsChanged(["DISCORD_POSTURES"], () => { throw new Error("presence refresh failed") })
  const app = createServer()
  try {
    const response = await app.inject({
      method: "POST", url: "/config/apply", headers: { authorization: "Bearer apply-token" },
      payload: { revision: 9, settings: { DISCORD_POSTURES: JSON.stringify({ hearth: { bio: "around" } }) } },
    })
    assert.equal(response.statusCode, 500)
    assert.match(response.json().error, /presence refresh failed/)
  } finally {
    release()
    delete process.env.DISCORD_POSTURES
    await app.close()
    if (priorToken === undefined) delete process.env.NIRI_CONFIG_TOKEN; else process.env.NIRI_CONFIG_TOKEN = priorToken
  }
})
