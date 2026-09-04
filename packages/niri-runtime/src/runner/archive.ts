import {
  createContextCompactor,
  createLcmEngine,
  createSqliteContextArchive,
  defaultPruneConfig,
  type ContextCompactor,
  type LcmConfig,
  type SqliteContextArchive,
  type SummarizerModel,
  type SummaryCircuit,
} from "@mira/agent-context"
import type { ProviderSet } from "@mira/agent-llm"
import { getDb } from "../db"
import { AGENT_NAME } from "./util"
import { niriSummaryPrompts } from "./summary-prompts"

/**
 * Niri's context archive and compactor.
 *
 * The archive runs against the same `context_*` tables `runner/context-store.ts`
 * owned, on the same database, so existing summary lineage stays intact.
 */

let archive: SqliteContextArchive | null = null

/** Lazily bound so importing this module does not open the database. */
export function contextArchive(): SqliteContextArchive {
  return (archive ??= createSqliteContextArchive(getDb()))
}

export function lcmConfigFromEnv(): LcmConfig {
  const int = (value: string | undefined, fallback: number, min: number): number => {
    const parsed = Number.parseInt(value ?? `${fallback}`, 10)
    return Math.max(min, Number.isFinite(parsed) ? parsed : fallback)
  }
  const trigger = int(process.env.CONTEXT_COMPACT_TRIGGER_TOKENS, 90_000, 1)
  return {
    summaryBatchSize: int(process.env.LCM_SUMMARY_BATCH_SIZE, 4, 2),
    compactTriggerTokens: trigger,
    compactHardTriggerTokens: Math.max(trigger + 1, int(process.env.CONTEXT_COMPACT_HARD_TRIGGER_TOKENS, 115_000, 1)),
    compactMinNewMessages: int(process.env.CONTEXT_COMPACT_MIN_NEW_MESSAGES, 24, 1),
  }
}

/**
 * Tool output that must survive compaction untouched.
 *
 * Social and memory traffic is the record itself, so excerpting it would
 * destroy the thing the agent is meant to remember. Workspace output is
 * reproducible and safe to excerpt.
 */
export function isProtectedToolOutput(toolName: string): boolean {
  if (!toolName) return false
  return (
    toolName.startsWith("discord_") ||
    toolName.startsWith("memory_") ||
    toolName.startsWith("soul_") ||
    toolName.startsWith("context_") ||
    toolName === "schedule" ||
    toolName === "wait" ||
    toolName === "wait_then_continue" ||
    toolName === "rest" ||
    toolName === "delegate"
  )
}

/** Adapts a provider into the narrow model interface the summarizer needs. */
function summarizerFor(providers: ProviderSet) {
  return async (): Promise<{ model: SummarizerModel; circuit: SummaryCircuit } | null> => {
    const resolved = await providers.resolveSummary()
    if (!resolved) return null
    const { provider } = resolved
    return {
      model: {
        id: provider.id,
        model: provider.model,
        async completeText(system, user) {
          const result = await provider.complete(
            {
              model: provider.model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              tools: [],
              tool_choice: "none",
            },
            // Summarization is not user-facing; never stream it to clients.
            { sink: null, toolChoice: "none" },
          )
          const text = result.message.content
          return typeof text === "string" ? text.trim() : ""
        },
      },
      circuit: {
        isOpen: () => providers.circuitStatus(provider).open,
        recordFailure: (err) => providers.recordFailure(provider, err),
        recordUnusable: (reason) => providers.recordUnusable(provider, reason),
        recordSuccess: () => providers.recordSuccess(provider),
      },
    }
  }
}

export function createNiriCompactor(
  providers: ProviderSet,
  options: {
    grounding: () => Promise<string | null>
    toolsForEstimate: () => unknown
    recentMinKeep: number
    recentMaxKeep: number
    tailCharBudget: number
  },
): ContextCompactor {
  const config = lcmConfigFromEnv()
  const archiveInstance = contextArchive()
  return createContextCompactor({
    agentName: AGENT_NAME,
    archive: archiveInstance,
    lcm: createLcmEngine({
      archive: archiveInstance,
      agentName: AGENT_NAME,
      batchSize: config.summaryBatchSize,
    }),
    config,
    prompts: niriSummaryPrompts,
    prune: { ...defaultPruneConfig, protectedToolNames: isProtectedToolOutput },
    resolveSummarizer: summarizerFor(providers),
    recentMinKeep: options.recentMinKeep,
    recentMaxKeep: options.recentMaxKeep,
    tailCharBudget: options.tailCharBudget,
    toolsForEstimate: options.toolsForEstimate,
  })
}
