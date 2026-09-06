import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog, modelFacingClientCapabilities } from "./tool-catalog"

test("Niri catalog keeps server tools separate from client capabilities", () => {
  const names = createNiriToolCatalog({ discord: false }).map((tool) => tool.function.name)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("memory_search"), true)
  assert.equal(names.includes("work"), true)
  const work = createNiriToolCatalog({ discord: false }).find((tool) => tool.function.name === "work")!
  assert.equal(work.function.parameters.additionalProperties, false)
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


test("process_job is opt-in and has the closed lifecycle actions", () => {
  assert.equal(createNiriToolCatalog().some((tool) => tool.function.name === "process_job"), false)
  const tool = createNiriToolCatalog({ processJobs: true }).find((candidate) => candidate.function.name === "process_job")
  assert.ok(tool)
  const action = (tool.function.parameters.properties as Record<string, { enum?: string[] }>).action
  assert.deepEqual(action?.enum, ["start", "get", "list", "cancel"])
})

const postureDescription = (): string =>
  createNiriToolCatalog({ discord: true }).find((tool) => tool.function.name === "posture")!.function.description

test("the posture tool describes the mechanism and borrows no persona", () => {
  const original = process.env.DISCORD_POSTURES
  delete process.env.DISCORD_POSTURES
  try {
    const description = postureDescription()
    assert.match(description, /hearth: discord events enter context live/)
    assert.match(description, /bypass users and channels from discord\.posture_bypass always get through/)
    assert.equal(/violet/i.test(description), false)
    assert.equal(/future-niri|\bana\b|\bnova\b/i.test(description), false, "no agent or person is named in the default catalog")
  } finally {
    if (original === undefined) delete process.env.DISCORD_POSTURES
    else process.env.DISCORD_POSTURES = original
  }
})

test("configured posture wording reaches the tool description verbatim", () => {
  const original = process.env.DISCORD_POSTURES
  process.env.DISCORD_POSTURES = JSON.stringify({
    hearth: { description: "the fire people gather around.", guidance: "choose it when the social fabric matters more than the building.", bio: "violet light, warm and steady." },
    "deep-focus": { description: "one thing, all the way down." },
  })
  try {
    const description = postureDescription()
    assert.ok(description.includes("hearth — the fire people gather around."))
    assert.ok(description.includes("choose it when the social fabric matters more than the building."))
    assert.ok(description.includes('hearth bio: "violet light, warm and steady."'))
    assert.ok(description.includes("deep-focus — one thing, all the way down."))
    assert.ok(description.startsWith("Get or change how Discord events enter context."))
  } finally {
    if (original === undefined) delete process.env.DISCORD_POSTURES
    else process.env.DISCORD_POSTURES = original
  }
})
