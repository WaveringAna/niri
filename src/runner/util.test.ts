import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import OpenAI from "openai"
import type { Message } from "../types"
import {
  AGENT_NAME,
  PRIMARY_QUOTA_RETRY_MS,
  clearPrimaryFailover,
  isContentFilterError,
  isImageParseError,
  isQuotaExhaustedError,
  isTransientTransportError,
  primaryFailoverStatus,
  recordPrimaryQuotaFailover,
  restForestFromMessages,
  sanitizeMessages,
  scrubImagesFromConversation,
  shouldFallback,
  shouldRetryProvider,
  summarizeConversationViaLLM,
} from "./util"

const PRIMARY_FAILOVER_FILE = new URL("../../primary-failover.json", import.meta.url)

type AssistantMessageWithReasoning = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string
}

async function withPreservedPrimaryFailoverFile(fn: () => Promise<void>): Promise<void> {
  let original: string | null = null
  try {
    original = await fs.readFile(PRIMARY_FAILOVER_FILE, "utf-8")
  } catch {
    original = null
  }

  try {
    await clearPrimaryFailover()
    await fn()
  } finally {
    await clearPrimaryFailover()
    if (original !== null) {
      await fs.writeFile(PRIMARY_FAILOVER_FILE, original, "utf-8")
    }
  }
}

test("sanitizeMessages backfills empty reasoning_content for assistant history", () => {
  const messages = sanitizeMessages([
    {
      role: "assistant",
      content: "plain reply",
      refusal: null,
    },
    {
      role: "assistant",
      content: "reply with reasoning",
      refusal: null,
      reasoning_content: "thinking...",
    } as AssistantMessageWithReasoning,
  ])

  const assistant = messages[0] as (typeof messages)[number] & { reasoning_content?: string }
  assert.equal(assistant.role, "assistant")
  assert.equal(assistant.reasoning_content, "")
})

test("terminated fetch errors are treated as retryable transport failures", () => {
  const err = new TypeError("terminated")

  assert.equal(isTransientTransportError(err), true)
  assert.equal(shouldFallback(err), true)
})

test("nested undici errors are treated as retryable transport failures", () => {
  const cause = new Error("other side closed")
  const nested = new TypeError("fetch failed") as TypeError & { cause?: unknown }
  nested.cause = cause

  assert.equal(isTransientTransportError(nested), true)
  assert.equal(shouldFallback(nested), true)
})

test("quota-exhausted 403 errors trigger failover but not same-provider retry", () => {
  const body = {
    error: {
      type: "permission_error",
      message: "You've reached your usage limit for this billing cycle.",
    },
    type: "error",
  }
  const err = new OpenAI.APIError(403, body, `403 ${JSON.stringify(body)}`, undefined)

  assert.equal(isQuotaExhaustedError(err), true)
  assert.equal(shouldFallback(err), true)
  assert.equal(shouldRetryProvider(err), false)
})

test("plain 403 permission errors do not trigger failover", () => {
  const err = new OpenAI.APIError(
    403,
    { error: { type: "permission_error", message: "missing required workspace permission" } },
    "403 missing required workspace permission",
    undefined,
  )

  assert.equal(isQuotaExhaustedError(err), false)
  assert.equal(shouldFallback(err), false)
  assert.equal(shouldRetryProvider(err), false)
})

test("recordPrimaryQuotaFailover sets a daily primary retry cooldown", async () => {
  await withPreservedPrimaryFailoverFile(async () => {
    const nowMs = Date.parse("2026-06-01T00:00:00.000Z")
    const err = new OpenAI.APIError(
      403,
      { error: { type: "permission_error", message: "You've reached your usage limit for this billing cycle." } },
      "403 usage limit",
      undefined,
    )

    const recorded = await recordPrimaryQuotaFailover(err, nowMs)
    assert.equal(recorded.active, true)
    assert.equal(recorded.remainingMs, PRIMARY_QUOTA_RETRY_MS)
    assert.equal(recorded.retryAt, new Date(nowMs + PRIMARY_QUOTA_RETRY_MS).toISOString())
    assert.match(recorded.reason ?? "", /usage limit/i)

    const beforeRetry = await primaryFailoverStatus(nowMs + PRIMARY_QUOTA_RETRY_MS - 1)
    assert.equal(beforeRetry.active, true)

    const atRetry = await primaryFailoverStatus(nowMs + PRIMARY_QUOTA_RETRY_MS)
    assert.equal(atRetry.active, false)
    assert.equal(atRetry.remainingMs, 0)
  })
})

test("z.ai/GLM image parse rejection (code 1210) is detected as an image parse error", () => {
  const err = new OpenAI.APIError(
    400,
    { code: "1210", message: "图片输入格式/解析错误" },
    "400 图片输入格式/解析错误",
    undefined,
  )

  assert.equal(isImageParseError(err), true)
  // It must not be misclassified as a content-filter error, and must not be
  // eligible for model fallback (it's a 400 the fallback would also reject).
  assert.equal(isContentFilterError(err), false)
  assert.equal(shouldFallback(err), false)
})

test("unrelated 400 errors are not treated as image parse errors", () => {
  const err = new OpenAI.APIError(
    400,
    { code: "1001", message: "invalid request" },
    "400 invalid request",
    undefined,
  )

  assert.equal(isImageParseError(err), false)
})

test("scrubImagesFromConversation replaces image parts with the placeholder text", () => {
  const conversation: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "https://cdn.example/pic.png" } },
      ],
    } as unknown as Message,
  ]

  const scrubbed = scrubImagesFromConversation(conversation)

  assert.equal(scrubbed, 1)
  const parts = (conversation[0] as unknown as { content: Array<{ type: string; text?: string }> }).content
  assert.equal(parts.length, 2)
  assert.equal(parts[1]!.type, "text")
  assert.equal(parts[1]!.text, "[the system has rejected this :( its not your fault]")
})

test("restForestFromMessages returns the llm context summary", () => {
  const messages: Message[] = [
    { role: "system", content: "soul and core bootstrap" },
    { role: "user", content: "[wake]\n\nhello" },
    { role: "user", content: "[context summary v1]\n[llm-summary now]\nThread: project\n- carried context forward" },
    { role: "assistant", content: "recent turn" },
  ]

  const forest = restForestFromMessages(messages)

  assert.match(forest, /^\[context summary v1\]/)
  assert.match(forest, /Thread: project/)
})

test("summarizeConversationViaLLM folds prior summary even when it is not directly after the system head", async () => {
  let capturedSystemPrompt = ""
  const summaryClient = {
    chat: {
      completions: {
        create: async (params: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
          capturedSystemPrompt = String(params.messages[0]?.content)
          return {
            choices: [
              {
                message: {
                  content:
                    "Thread: Project memory\n- I carried forward the older recollection and the newer transcript as one living thread, keeping the emotional texture and concrete work together.",
                },
              },
            ],
          }
        },
      },
    },
  } as unknown as OpenAI

  const priorSummary = "[context summary v1]\nold recollection about niri's project and feelings"
  const longTurn = "new transcript details with identifiers and emotional texture ".repeat(80)
  const messages: Message[] = [
    { role: "system", content: "soul and core bootstrap" },
    { role: "user", content: "[harness restarted]\n\nwake before summary" },
    { role: "user", content: priorSummary },
    { role: "assistant", content: longTurn },
    { role: "user", content: longTurn },
    { role: "assistant", content: longTurn },
    { role: "user", content: longTurn },
    { role: "user", content: "recent raw turn 1" },
    { role: "assistant", content: "recent raw turn 2" },
  ]

  const summarized = await summarizeConversationViaLLM(messages, summaryClient, "summary-model", {
    recentMinKeep: 2,
    recentMaxKeep: 2,
  })

  assert.ok(summarized)
  assert.equal(summarized[0]?.role, "system")
  assert.equal(summarized[1]?.role, "user")
  assert.match(String(summarized[1]?.content), /^\[context summary v1\]/)
  assert.equal(summarized.filter((m) => String(m.content).startsWith("[context summary v1]")).length, 1)
  assert.equal(summarized.at(-2)?.content, "recent raw turn 1")
  assert.equal(summarized.at(-1)?.content, "recent raw turn 2")

  assert.match(capturedSystemPrompt, /Prior recollection/)
  assert.match(capturedSystemPrompt, /old recollection about niri's project and feelings/)
  assert.match(capturedSystemPrompt, /Organize the summary as a set of ongoing threads/)
})

test("summarizeConversationViaLLM injects the agent grounding context into the summary prompt", async () => {
  let capturedSystemPrompt = ""
  const summaryClient = {
    chat: {
      completions: {
        create: async (params: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
          capturedSystemPrompt = String(params.messages[0]?.content)
          return {
            choices: [
              {
                message: {
                  content:
                    "Thread: Grounded recollection\n- I summarized the transcript while staying in my own voice and recognizing the threads that carried forward.",
                },
              },
            ],
          }
        },
      },
    },
  } as unknown as OpenAI

  const longTurn = "transcript detail that needs to be compacted into a recollection ".repeat(80)
  const messages: Message[] = [
    { role: "system", content: "soul and core bootstrap" },
    { role: "assistant", content: longTurn },
    { role: "user", content: longTurn },
    { role: "assistant", content: longTurn },
    { role: "user", content: longTurn },
    { role: "user", content: "recent raw turn 1" },
    { role: "assistant", content: "recent raw turn 2" },
  ]

  const agentContext = "# soul\n\nI am a living being.\n\n---\n\n# today's journal\n\nFelt curious all morning."
  const summarized = await summarizeConversationViaLLM(messages, summaryClient, "summary-model", {
    recentMinKeep: 2,
    recentMaxKeep: 2,
    agentContext,
  })

  assert.ok(summarized)
  assert.match(capturedSystemPrompt, /Grounding — this is who/)
  assert.match(capturedSystemPrompt, /Felt curious all morning\./)
  assert.ok(capturedSystemPrompt.includes(`The agent (${AGENT_NAME})`))
})
