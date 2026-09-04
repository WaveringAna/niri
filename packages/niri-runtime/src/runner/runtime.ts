import type { Message as ContextMessage } from "@mira/agent-context"
import { createProviderSet, resolveProviderConfig, type ProviderSet } from "@mira/agent-llm"
import type { AgentEvent, AgentInput, AgentRuntime, LoopState } from "@mira/agent-loop"
import { resolveTools } from "@mira/agent-loop"
import { AGENT_ID, NIRI_HOME } from "../agent-config"
import { buildBootstrap } from "../bootstrap"
import { clientTools } from "../client"
import { endConversation, logMessage, startConversation } from "../db"
import { areDiscordToolsAvailable } from "../discord/availability"
import { delegationProfileNames, isDelegationAvailable } from "../delegation/manager"
import { buildCompletionMessages, rememberRecalledMemoryChunks } from "../memory"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { UserMessage } from "../types"
import { createNiriCompactor, contextArchive } from "./archive"
import { niriToolModules } from "./modules"
import { niriTurnPolicies } from "./policies"
import { modelFacingClientCapabilities } from "./tool-catalog"
import {
  AGENT_NAME,
  AGENT_STATE_DIR,
  clearSession,
  loadAgentSummaryContext,
  loadRestSnapshot,
  loadSession,
  sanitizeMessages,
  saveRestSnapshot,
  saveSession,
  scrubImagesFromConversation,
} from "./util"

/**
 * Assembles Niri as an `AgentRuntime`.
 *
 * Everything harness-specific about her now lives behind one of these fields.
 * A different agent builds a different runtime and reuses the same loop.
 */

const RECENT_MIN_KEEP = 6
const RECENT_MAX_KEEP = 40
const TAIL_CHAR_BUDGET = 60_000

/**
 * Passive memory recall bookkeeping.
 *
 * This used to be three fields on `LoopState`, which meant every harness built
 * on the loop carried Niri's memory model. It lives in `state.extras` now,
 * keyed by the module that owns it.
 */
export type RecallState = {
  cooldowns: Record<number, number>
  turn: number
  pending: boolean
}

const RECALL_KEY = "memory"

export function recallState(state: LoopState): RecallState {
  let recall = state.extras.get(RECALL_KEY) as RecallState | undefined
  if (!recall) {
    recall = { cooldowns: {}, turn: 0, pending: false }
    state.extras.set(RECALL_KEY, recall)
  }
  return recall
}

/** Marks the start of a new incoming turn, so recall runs once for it. */
export function markRecallPending(state: LoopState): void {
  recallState(state).pending = true
}

export function createNiriProviders(): ProviderSet {
  return createProviderSet(resolveProviderConfig(process.env), { agentId: AGENT_ID })
}

export function createNiriRuntime(providers: ProviderSet): AgentRuntime {
  const identity = { id: AGENT_ID, name: AGENT_NAME, homeDir: NIRI_HOME, stateDir: AGENT_STATE_DIR }
  const archive = contextArchive()

  const getTools = () =>
    resolveTools(niriToolModules, { identity, runtime: runtime as AgentRuntime }).definitions

  const compactor = createNiriCompactor(providers, {
    grounding: loadAgentSummaryContext,
    toolsForEstimate: getTools,
    recentMinKeep: RECENT_MIN_KEEP,
    recentMaxKeep: RECENT_MAX_KEEP,
    tailCharBudget: TAIL_CHAR_BUDGET,
  })

  const runtime: AgentRuntime = {
    identity,
    providers,
    compactor,
    modules: niriToolModules,
    policies: niriTurnPolicies,

    session: {
      load: loadSession,
      save: saveSession,
      clear: clearSession,
      async loadRestSnapshot() {
        const snapshot = await loadRestSnapshot()
        if (!snapshot) return null
        return {
          restedAt: snapshot.restedAt,
          ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
          segments: snapshot.forests?.length ? snapshot.forests : [snapshot.forest],
        }
      },
      saveRestSnapshot,
    },

    transcript: { startConversation, logMessage, endConversation },
    events: { emit: (event: AgentEvent) => emit(event as never) },
    metrics: { record: (metric) => { recordMetric(metric as never) } },

    getTools,
    summaryGrounding: loadAgentSummaryContext,

    async buildBootstrap(input: AgentInput) {
      return (await buildBootstrap(input as UserMessage, await loadRestSnapshot(), {
        clientCapabilities: modelFacingClientCapabilities(clientTools.getCapabilities()),
        workspace: clientTools.getWorkspace(),
        discord: areDiscordToolsAvailable(),
        delegationProfiles: isDelegationAvailable() ? delegationProfileNames() : [],
      })) as ContextMessage[]
    },

    /**
     * Sanitize, then recall, then batch the active summaries.
     *
     * Recall runs only on the first step of a turn: re-running it on every
     * agentic iteration floods context with the same chunks for the same
     * unchanged user message.
     */
    async prepareCompletionMessages(messages, state) {
      const recall = recallState(state)
      const sanitized = sanitizeMessages(messages as never) as ContextMessage[]
      state.conversation = sanitized

      if (!recall.pending) return archive.batchActiveContextSummariesForPrompt(sanitized)

      const recalled = await buildCompletionMessages(sanitized as never, recall.cooldowns, recall.turn)
      // Marking here rather than on success is idempotent within a turn:
      // rememberRecalledMemoryChunks maps chunk id to the current turn number.
      recall.cooldowns = rememberRecalledMemoryChunks(recall.cooldowns, recalled.recalledChunkIds, recall.turn)
      return archive.batchActiveContextSummariesForPrompt(recalled.messages as ContextMessage[])
    },

    async onPromptTooLarge(state, attempt) {
      console.warn(`[api] prompt too large; compacting (attempt ${attempt})`)
      const outcome = await compactor.maybeCompact({
        messages: state.conversation,
        // Force a pass regardless of the observed size that got us here.
        observedPromptTokens: Number.MAX_SAFE_INTEGER,
        phase: `recovery-${attempt}`,
        grounding: await loadAgentSummaryContext(),
      })
      if (!outcome.applied) return false
      state.conversation = outcome.messages
      state.contextSize = outcome.afterTokens
      return true
    },

    onContentRejected(state, kind) {
      const scrubbed = scrubImagesFromConversation(state.conversation as never)
      if (scrubbed > 0) {
        console.warn(`[api] ${kind}; scrubbed ${scrubbed} image attachment(s) and retrying`)
        return true
      }
      console.warn(`[api] ${kind} but no images found to scrub`)
      return false
    },
  }

  return runtime
}
