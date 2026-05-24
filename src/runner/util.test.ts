import assert from "node:assert/strict"
import test from "node:test"
import OpenAI from "openai"
import type { Message } from "../types"
import {
  isContentFilterError,
  isImageParseError,
  isTransientTransportError,
  sanitizeMessages,
  scrubImagesFromConversation,
  shouldFallback,
  summarizeConversationViaLLM,
} from "./util"

type AssistantMessageWithReasoning = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string
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
