import type OpenAI from "openai"
import { AGENT_ID } from "../agent-config"
import { clientTools } from "../client"
import { logMessage } from "../db"
import { createClientToolCatalog, type ToolDefinition } from "@mira/harness-core"
import { callMcpTool, getMcpToolDefinitions, hasMcpTool } from "../mcp"
import { addAssistantMessage, applyUsage, fetchIsolatedCompletion } from "../runner/loop-completion"
import { buildToolHandlers } from "../runner/loop-tool-registry"
import { executeToolCall, pushToolMessage } from "../runner/loop-tool-runtime"
import { isFunctionToolCall } from "../runner/loop-content"
import { parseToolArguments } from "../runner/util"
import type { FunctionToolCall } from "../runner/loop-shared"
import type { LoopHooks, LoopState } from "../runner/types"
import type { DelegationProfile } from "./config"
import { listDelegationProfileFeedback, type DelegatedTask, type DelegatedTaskMessage, type DelegatedMessageKind } from "./store"

const PROFILE_FEEDBACK_MAX_CHARS = 12_000

const TASK_MESSAGE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "task_message",
    description: "Send a deliberate progress update, blocking question, or final result to Niri and the task's observable Gastown thread. Progress updates enter Niri's event stream, so send only meaningful milestones rather than ordinary thoughts or raw command output.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["progress", "question", "result"] },
        content: { type: "string", minLength: 1 },
      },
      required: ["kind", "content"],
    },
  },
}

export type DelegatedSubagentCallbacks = {
  publish: (kind: Extract<DelegatedMessageKind, "progress" | "question" | "result">, content: string) => Promise<void>
  readInbox: (afterSeq: number) => DelegatedTaskMessage[]
  waitForInput: (afterSeq: number, timeoutMs: number) => Promise<void>
  isCancelled: () => boolean
  recordUsage: (tokenCount: number, contextSize: number) => void
}

export type DelegatedSubagentResult = {
  result: string
  tokenCount: number
  contextSize: number
}

function workerTools(profile: DelegationProfile): ToolDefinition[] {
  const allowed = new Set<string>(profile.tools)
  const allowedMcp = new Set(profile.mcpTools)
  return [
    ...createClientToolCatalog({
      clientCapabilities: clientTools.getCapabilities().filter((capability) => allowed.has(capability)),
      workspace: clientTools.getWorkspace(),
    }).filter((tool) => allowed.has(tool.function.name)),
    ...getMcpToolDefinitions().filter((tool) => allowedMcp.has(tool.function.name)),
    TASK_MESSAGE_TOOL,
  ]
}

function taskSystemPrompt(task: DelegatedTask, profile: DelegationProfile): string {
  const workspace = clientTools.getWorkspace()
  const feedbackLines: string[] = []
  let feedbackChars = 0
  for (const feedback of listDelegationProfileFeedback(profile.name).filter((item) => item.taskId !== task.id)) {
    const line = `[${feedback.createdAt} · ${feedback.taskId}] ${feedback.content}`
    const separatorChars = feedbackLines.length > 0 ? 2 : 0
    if (feedbackChars + separatorChars + line.length > PROFILE_FEEDBACK_MAX_CHARS) break
    feedbackLines.push(line)
    feedbackChars += separatorChars + line.length
  }
  feedbackLines.reverse()
  return [
    profile.systemPrompt,
    "you are a temporary task worker operating for niri. you are not niri and you do not speak as her.",
    `your task id is ${task.id}.`,
    profile.model ? `your configured task model is ${profile.model}.` : "",
    `you have at most ${profile.maxTurns} model turns.`,
    workspace ? `your attached workspace is ${workspace.root}.` : "no workspace is currently attached.",
    "stay within the task. preserve unrelated work. report evidence and verification.",
    feedbackLines.length > 0
      ? `niri's durable feedback from your profile's previous tasks follows. treat it as standing guidance unless the current objective explicitly overrides it:\n\n${feedbackLines.join("\n\n")}`
      : "niri has not recorded durable feedback for this worker profile yet.",
    "use task_message for meaningful progress, questions that block you, and your final result. do not publish private reasoning or every command.",
    "if you ask a question with task_message, you will pause until a collaborator answers in niri or the discord task thread.",
  ].filter(Boolean).join("\n\n")
}

function injectInbox(state: LoopState, messages: DelegatedTaskMessage[]): number {
  let lastSeq = 0
  for (const message of messages) {
    lastSeq = Math.max(lastSeq, message.seq)
    state.conversation.push({
      role: "user",
      content: `[task message from ${message.senderName} · ${message.kind}]\n\n${message.content}`,
    })
  }
  return lastSeq
}

function remainingTaskMs(deadline: number, timeoutMs: number, callbacks: DelegatedSubagentCallbacks): number {
  if (callbacks.isCancelled()) throw new Error("task cancelled")
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`task exceeded ${timeoutMs}ms timeout`)
  return remaining
}

function trackShellSession(state: LoopState, call: FunctionToolCall, activeSessions: Set<string>): void {
  for (let index = state.conversation.length - 1; index >= 0; index -= 1) {
    const message = state.conversation[index]
    if (message.role !== "tool" || message.tool_call_id !== call.id || typeof message.content !== "string") continue
    const running = message.content.match(/\[shell session (sh_[a-zA-Z0-9]+) is (?:still running|termination requested);/)
    if (running?.[1]) activeSessions.add(running[1])
    const finished = message.content.match(/\[shell session (sh_[a-zA-Z0-9]+) (?:exited|terminated|failed)\b/)
    if (finished?.[1]) activeSessions.delete(finished[1])
    return
  }
}

async function terminateShellSessions(sessionIds: Set<string>): Promise<void> {
  await Promise.all([...sessionIds].map(async (sessionId) => {
    await clientTools.execute({
      agentId: AGENT_ID,
      tool: "shell",
      args: { action: "terminate", session_id: sessionId, timeout_ms: 1000 },
      timeoutMs: 2000,
    }).catch((err) => {
      console.warn(`[delegation] failed to terminate shell session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }))
}

export async function runDelegatedSubagent(
  convId: number,
  task: DelegatedTask,
  profile: DelegationProfile,
  callbacks: DelegatedSubagentCallbacks,
  timeoutMs: number,
): Promise<DelegatedSubagentResult> {
  const tools = workerTools(profile)
  const state: LoopState = {
    conversation: [
      { role: "system", content: taskSystemPrompt(task, profile) },
      { role: "user", content: task.objective },
    ],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
  }
  const handlers = buildToolHandlers({ clientTools }, { emitClientToolEvents: false })
  const allowedHandlers = new Set<string>(profile.tools)
  const allowedMcpTools = new Set(profile.mcpTools)
  const hooks: LoopHooks = {
    clientTools,
    getTools: () => tools,
    waitForEvent: async () => null,
    waitForEventWithTimeout: async () => null,
    injectIncomingEvent: () => {},
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: callbacks.isCancelled,
    resolveShutdown: () => {},
  }
  const deadline = Date.now() + timeoutMs
  let lastInboxSeq = 1
  let lastText = ""
  const activeShellSessions = new Set<string>()

  try {
    for (let turn = 0; turn < profile.maxTurns; turn += 1) {
      remainingTaskMs(deadline, timeoutMs, callbacks)

      const inbox = callbacks.readInbox(lastInboxSeq)
      if (inbox.length > 0) lastInboxSeq = Math.max(lastInboxSeq, injectInbox(state, inbox))

      const response = await fetchIsolatedCompletion(
        state.conversation as OpenAI.Chat.ChatCompletionMessageParam[],
        tools,
        "auto",
        { model: profile.model },
      )
      applyUsage(
        state,
        response.usage,
        { elapsedMs: response.elapsedMs, tokensPerSecond: response.tokensPerSecond },
        { emitEvent: false },
      )
      callbacks.recordUsage(state.tokenCount, state.contextSize)
      addAssistantMessage(convId, state, response.message)
      remainingTaskMs(deadline, timeoutMs, callbacks)
      const text = typeof response.message.content === "string" ? response.message.content.trim() : ""
      if (text) lastText = text
      const calls = (response.message.tool_calls ?? []).filter(isFunctionToolCall)

      if (calls.length === 0) {
        const result = lastText || "task completed without a textual result"
        await callbacks.publish("result", result)
        return { result, tokenCount: state.tokenCount, contextSize: state.contextSize }
      }

      let publishedResult: string | null = null
      for (const call of calls) {
        remainingTaskMs(deadline, timeoutMs, callbacks)
        if (call.function.name === "task_message") {
          const parsed = parseToolArguments(call.function.arguments)
          if (!parsed.ok) {
            pushToolMessage(convId, state, call as FunctionToolCall, `error: ${parsed.error}`)
            continue
          }
          const kind = parsed.args.kind
          const content = typeof parsed.args.content === "string" ? parsed.args.content.trim() : ""
          if ((kind !== "progress" && kind !== "question" && kind !== "result") || !content) {
            pushToolMessage(convId, state, call as FunctionToolCall, "error: task_message requires kind=progress|question|result and non-empty content")
            continue
          }
          await callbacks.publish(kind, content)
          remainingTaskMs(deadline, timeoutMs, callbacks)
          pushToolMessage(convId, state, call as FunctionToolCall, kind === "question" ? "question delivered; pausing until a collaborator answers" : `${kind} delivered`)
          if (kind === "result") {
            publishedResult = content
            break
          }
          if (kind === "question") {
            await callbacks.waitForInput(lastInboxSeq, remainingTaskMs(deadline, timeoutMs, callbacks))
            remainingTaskMs(deadline, timeoutMs, callbacks)
            const answers = callbacks.readInbox(lastInboxSeq)
            if (answers.length > 0) lastInboxSeq = Math.max(lastInboxSeq, injectInbox(state, answers))
          }
          continue
        }

        if (!allowedHandlers.has(call.function.name)) {
          if (allowedMcpTools.has(call.function.name)) {
            const parsed = parseToolArguments(call.function.arguments)
            if (!parsed.ok) {
              pushToolMessage(convId, state, call as FunctionToolCall, `error: ${parsed.error}`)
            } else if (!hasMcpTool(call.function.name)) {
              pushToolMessage(convId, state, call as FunctionToolCall, `error: MCP tool ${call.function.name} is disconnected`)
            } else {
              const result = await callMcpTool(call.function.name, parsed.args).catch((err) => `error: ${err instanceof Error ? err.message : String(err)}`)
              pushToolMessage(convId, state, call as FunctionToolCall, result)
            }
            remainingTaskMs(deadline, timeoutMs, callbacks)
            continue
          }
          pushToolMessage(convId, state, call as FunctionToolCall, `error: ${call.function.name} is not available to this task worker`)
          continue
        }
        await executeToolCall(convId, state, hooks, handlers, call as FunctionToolCall)
        if (call.function.name === "shell") trackShellSession(state, call as FunctionToolCall, activeShellSessions)
        remainingTaskMs(deadline, timeoutMs, callbacks)
      }

      if (publishedResult) {
        return { result: publishedResult, tokenCount: state.tokenCount, contextSize: state.contextSize }
      }
    }

    remainingTaskMs(deadline, timeoutMs, callbacks)
    const result = lastText || `task reached its ${profile.maxTurns}-turn limit without a final result`
    await callbacks.publish("result", result)
    logMessage(convId, "system", `[delegation] ${result}`)
    return { result, tokenCount: state.tokenCount, contextSize: state.contextSize }
  } finally {
    await terminateShellSessions(activeShellSessions)
  }
}

export const __delegationSubagentTest = { taskSystemPrompt }
