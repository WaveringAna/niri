import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog, modelFacingClientCapabilities } from "./tool-catalog"

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
  const action = (tool.function.parameters.properties as Record<string, { enum?: string[] }>).action
  assert.deepEqual(action?.enum, ["spawn", "send", "feedback", "status", "list", "cancel", "read"])
})


test("Python replaces legacy model-facing workspace tools by default with a compatibility escape hatch",()=>{
 const prior=process.env.NIRI_LEGACY_WORKSPACE_TOOLS
 try {
  delete process.env.NIRI_LEGACY_WORKSPACE_TOOLS
  assert.deepEqual(modelFacingClientCapabilities(["python","shell","read_file","edit_file","image_tool","read_blob"]),["python","image_tool"])
  process.env.NIRI_LEGACY_WORKSPACE_TOOLS="true"
  assert.deepEqual(modelFacingClientCapabilities(["python","shell","read_file"]),["python","shell","read_file"])
  delete process.env.NIRI_LEGACY_WORKSPACE_TOOLS
  assert.deepEqual(modelFacingClientCapabilities(["shell","read_file"]),["shell","read_file"])
 } finally {if(prior===undefined)delete process.env.NIRI_LEGACY_WORKSPACE_TOOLS;else process.env.NIRI_LEGACY_WORKSPACE_TOOLS=prior}
})
