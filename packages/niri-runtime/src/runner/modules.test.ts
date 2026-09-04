import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveTools } from "@mira/agent-loop"
import type { AgentRuntime, ToolModuleContext } from "@mira/agent-loop"
import { clientTools } from "../client"
import { areDiscordToolsAvailable } from "../discord/availability"
import { delegationProfileNames, isDelegationAvailable } from "../delegation/manager"
import { getMcpToolDefinitions } from "../mcp"
import { niriToolModules } from "./modules"
import { createNiriToolCatalog, modelFacingClientCapabilities } from "./tool-catalog"

const CTX: ToolModuleContext = {
  identity: { id: "niri", name: "niri", homeDir: "/tmp", stateDir: "/tmp/state" },
  runtime: {} as AgentRuntime,
}

/** The catalog the runner built before tools were split into modules. */
function legacyCatalog(): string[] {
  return [
    ...createNiriToolCatalog({
      clientCapabilities: modelFacingClientCapabilities(clientTools.getCapabilities()),
      workspace: clientTools.getWorkspace(),
      memory: true,
      discord: areDiscordToolsAvailable(),
      delegationProfiles: isDelegationAvailable() ? delegationProfileNames() : [],
      processJobs: Boolean(clientTools.getWorkspace()?.shellSessionResults),
    }),
    ...getMcpToolDefinitions(),
  ].map((tool) => tool.function.name)
}

test("the modules expose exactly the tools the runner used to build directly", () => {
  const modular = resolveTools(niriToolModules, CTX).definitions.map((t) => t.function.name)
  assert.deepEqual([...modular].sort(), [...legacyCatalog()].sort())
})

test("no module silently claims a tool another module owns", () => {
  // resolveTools throws on collision; this asserts the partition is disjoint
  // rather than merely covering.
  assert.doesNotThrow(() => resolveTools(niriToolModules, CTX))
})

test("every declared tool has a handler behind it", () => {
  const { definitions, handlers } = resolveTools(niriToolModules, CTX)
  for (const tool of definitions) {
    assert.ok(handlers[tool.function.name], `${tool.function.name} has no handler`)
  }
})

test("disabled groups contribute nothing", () => {
  // Discord and delegation are inactive in tests, so their tools must be absent
  // rather than present-but-erroring.
  const names = resolveTools(niriToolModules, CTX).definitions.map((t) => t.function.name)
  if (!areDiscordToolsAvailable()) {
    assert.ok(!names.includes("discord_send"))
    assert.ok(!names.includes("posture"))
  }
  if (!isDelegationAvailable()) assert.ok(!names.includes("delegate"))
})

test("lifecycle tools are always present", () => {
  const names = resolveTools(niriToolModules, CTX).definitions.map((t) => t.function.name)
  for (const tool of ["wait", "wait_then_continue", "rest"]) assert.ok(names.includes(tool))
})
