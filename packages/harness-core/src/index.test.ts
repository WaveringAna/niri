import assert from "node:assert/strict"
import test from "node:test"
import { createClientToolCatalog } from "./index.js"

test("client catalog is empty without attached capabilities", () => {
  assert.deepEqual(createClientToolCatalog(), [])
})

test("client catalog exposes only the attached capabilities", () => {
  const tools = createClientToolCatalog({
    clientCapabilities: ["shell", "image_tool"],
    workspace: { id: "macbook", root: "/Users/mira/project", imageRoot: "/Users/mira/project/images" },
  })
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]))
  assert.equal(byName.has("shell"), true)
  assert.equal(byName.has("read_file"), false)
  assert.equal(byName.has("edit_file"), false)
  assert.match(byName.get("image_tool")?.function.description ?? "", /\/Users\/mira\/project\/images/)
  const shell = byName.get("shell")
  assert.match(shell?.function.description ?? "", /session_id/)
  assert.doesNotMatch(shell?.function.description ?? "", /stateful/)
  const parameters = shell?.function.parameters as {
    properties?: Record<string, { enum?: unknown; type?: unknown }>
  }
  assert.deepEqual(parameters.properties?.action?.enum, ["start", "poll", "terminate"])
  assert.equal(parameters.properties?.session_id?.type, "string")
})

test("write_file is create-only in the model-facing catalog", () => {
  const [tool] = createClientToolCatalog({ clientCapabilities: ["write_file"] })
  assert.equal(tool?.function.name, "write_file")
  assert.match(tool?.function.description ?? "", /fails if the path already exists/i)
  assert.deepEqual(tool?.function.parameters.required, ["path", "content"])
})

test("workspace reads and edits expose the shared hashline contract", () => {
  const tools = createClientToolCatalog({ clientCapabilities: ["python", "read_file", "edit_file"] })
  const byName = Object.fromEntries(tools.map((tool) => [tool.function.name, tool]))
  const python = byName.python
  assert.match(python?.function.description ?? "", /read\(path, start_line=1, end_line=None, hashline=False\)/)
  assert.match(python?.function.description ?? "", /edit\(path, target, content\)/)
  assert.match(python?.function.description ?? "", /niri\.whoami\(\)/)
  assert.match(python?.function.description ?? "", /niri\.budget\(\)/)

  const read = byName.read_file
  assert.equal((read?.function.parameters as { properties?: Record<string, { type?: unknown }> }).properties?.hashline?.type, "boolean")

  const edit = byName.edit_file
  assert.deepEqual(edit?.function.parameters.required, ["path", "target", "content"])
  assert.match(edit?.function.description ?? "", /hashline/i)
})
