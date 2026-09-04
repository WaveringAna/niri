import assert from "node:assert/strict"
import test from "node:test"
import { defaultPruneConfig, pruneToolOutputsForCompaction } from "@mira/agent-context"
import type { Message } from "@mira/agent-context"
import { isProtectedToolOutput } from "./archive"

const PRUNE = { ...defaultPruneConfig, protectedToolNames: isProtectedToolOutput }

test("compaction pruning excerpts large workspace output but preserves social tools", () => {
  const oldWorkspaceOutput = "workspace-result\n" + "w".repeat(12_000)
  const oldMemoryOutput = "memory-result\n" + "m".repeat(12_000)
  const messages: Message[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_python", type: "function", function: { name: "python", arguments: "{}" } },
        { id: "call_memory", type: "function", function: { name: "memory_read", arguments: "{}" } },
      ],
    } as Message,
    { role: "tool", tool_call_id: "call_python", content: oldWorkspaceOutput } as Message,
    { role: "tool", tool_call_id: "call_memory", content: oldMemoryOutput } as Message,
    { role: "user", content: "recent context\n" + "r".repeat(40_000) },
  ]

  const result = pruneToolOutputsForCompaction(messages, PRUNE)

  assert.equal(result.prunedMessages, 1)
  assert.ok(result.removedChars > 8_000)
  assert.match(String(result.messages[1]?.content), /tool output pruned during compaction/)
  assert.match(String(result.messages[1]?.content), /workspace-result/)
  assert.equal(result.messages[2]?.content, oldMemoryOutput)
  // The input array is never mutated; the archive keeps the original.
  assert.equal(messages[1]?.content, oldWorkspaceOutput)
})

test("the protected set covers the record, not reproducible workspace output", () => {
  for (const tool of ["discord_send", "memory_read", "soul_write", "context_grep", "schedule", "rest", "delegate"]) {
    assert.ok(isProtectedToolOutput(tool), `${tool} should be protected`)
  }
  for (const tool of ["python", "shell", "read_file", "process_job", ""]) {
    assert.ok(!isProtectedToolOutput(tool), `${tool} should be prunable`)
  }
})
