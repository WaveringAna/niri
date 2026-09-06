import assert from "node:assert/strict"
import test from "node:test"
import { HOT_SETTINGS, coldKeys, settingsDelta } from "./hot-settings.js"

test("a delta names every key whose value moved, including one that was removed", () => {
  const delta = settingsDelta(
    { DISCORD_DM_WHITELIST: "1", COOLDOWN_TZ: "UTC", MODEL: "a" },
    { DISCORD_DM_WHITELIST: "1,2", MODEL: "a", DISCORD_POSTURES: "{}" },
  )
  assert.deepEqual(delta, { COOLDOWN_TZ: null, DISCORD_DM_WHITELIST: "1,2", DISCORD_POSTURES: "{}" })
  assert.deepEqual(settingsDelta({ MODEL: "a" }, { MODEL: "a" }), {})
})

test("classification is an allowlist: anything unlisted is cold", () => {
  assert.deepEqual(coldKeys({ DISCORD_DM_WHITELIST: "1", COOLDOWN_TZ: null }), [])
  assert.deepEqual(coldKeys({ DISCORD_DM_WHITELIST: "1", NIRI_SOMETHING_NEW: "x" }), ["NIRI_SOMETHING_NEW"])
  // Gateway identity, providers, embeddings and process identity stay cold on purpose.
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_BOT_USER_ID", "DISCORD_GATEWAY_ENABLED", "MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ENABLE_THINKING", "EMBEDDING_MODEL", "NIRI_MCP_CONFIG", "NIRI_DELEGATION_CONFIG", "PORT", "HOME", "NIRI_CLIENT"]) {
    assert.equal(HOT_SETTINGS.has(key), false, `${key} must stay cold`)
  }
})
