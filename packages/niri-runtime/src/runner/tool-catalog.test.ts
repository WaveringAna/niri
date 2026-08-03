import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog } from "./tool-catalog"

test("Niri catalog keeps server tools separate from client capabilities", () => {
  const names = createNiriToolCatalog({ discord: false }).map((tool) => tool.function.name)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("memory_search"), true)
  assert.equal(names.includes("discord_send"), false)
})

test("Discord and client tools are independently gated", () => {
  const names = createNiriToolCatalog({
    clientCapabilities: ["read_file"],
    workspace: { id: "client", root: "/client" },
    discord: true,
  }).map((tool) => tool.function.name)
  assert.equal(names.includes("read_file"), true)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("discord_send"), true)
  assert.equal(names.includes("discord_mark"), true)
  assert.equal(names.includes("posture"), true)
})

test("delegation is gated and exposes only configured profile names", () => {
  const disabled = createNiriToolCatalog().map((tool) => tool.function.name)
  assert.equal(disabled.includes("delegate"), false)

  const tool = createNiriToolCatalog({ delegationProfiles: ["researcher", "coder"] })
    .find((candidate) => candidate.function.name === "delegate")
  assert.ok(tool)
  const profile = (tool.function.parameters.properties as Record<string, { enum?: string[] }>).profile
  assert.deepEqual(profile?.enum, ["researcher", "coder"])
})
