import OpenAI from "openai"
import { createCodexBridgeServer } from "../packages/niri-runtime/src/codex-bridge"

const port = Number.parseInt(process.env.CODEX_CACHE_PROBE_PORT ?? "8811", 10)
const model = process.env.CODEX_CACHE_PROBE_MODEL?.trim() || "gpt-5.6-terra"
const cacheKey = process.env.CODEX_CACHE_PROBE_KEY?.trim() || "niri:cache-probe:terra-low"
const bridge = createCodexBridgeServer()

type Message = OpenAI.Chat.ChatCompletionMessageParam

const stableContext = Array.from(
  { length: 420 },
  (_, index) => `stable-agent-fact-${index}: Mira keeps this exact synthetic fact in long-term memory for cache testing.`,
).join("\n")

const systemMessage: Message = {
  role: "system",
  content: [
    "You are a cache-test agent. Reply with only the word ack.",
    "The following synthetic context is deliberately repetitive and stable:",
    stableContext,
  ].join("\n\n"),
}

async function runTurn(client: OpenAI, label: string, messages: Message[]): Promise<string> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    prompt_cache_key: cacheKey,
    reasoning_effort: "low",
  } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & { reasoning_effort: "low" })

  let content = ""
  let usage: OpenAI.Completions.CompletionUsage | undefined
  for await (const chunk of stream) {
    content += chunk.choices[0]?.delta?.content ?? ""
    if (chunk.usage) usage = chunk.usage
  }

  console.log(JSON.stringify({
    label,
    promptTokens: usage?.prompt_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens,
    completionTokens: usage?.completion_tokens,
  }))
  return content || "ack"
}

await bridge.listen({ host: "127.0.0.1", port })
try {
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "codex-bridge" })

  const seed: Message[] = [systemMessage, { role: "user", content: "Seed the stable cache prefix. Reply ack." }]
  const seedAnswer = await runTurn(client, "seed", seed)

  const warm: Message[] = [...seed, { role: "assistant", content: seedAnswer }, { role: "user", content: "Warm continuation. Reply ack." }]
  const warmAnswer = await runTurn(client, "warm", warm)

  const beforeRecall: Message[] = [
    ...warm,
    { role: "assistant", content: warmAnswer },
    { role: "user", content: "This turn triggers passive recall. Reply ack." },
  ]
  const recalled: Message[] = [
    ...beforeRecall,
    {
      role: "user",
      content: "[memory recall — use silently as context]\nSynthetic recalled memory: Ana likes cache tests and this message exists for exactly one model request.",
    },
  ]
  const recalledAnswer = await runTurn(client, "temporary-memory", recalled)

  const cleanAfterRecall: Message[] = [
    ...beforeRecall,
    { role: "assistant", content: recalledAnswer },
    { role: "user", content: "The temporary memory is absent now. Reply ack." },
  ]
  const cleanAnswer = await runTurn(client, "after-memory-removal", cleanAfterRecall)

  const recovered: Message[] = [
    ...cleanAfterRecall,
    { role: "assistant", content: cleanAnswer },
    { role: "user", content: "Confirm the clean cache branch recovered. Reply ack." },
  ]
  await runTurn(client, "clean-branch-recovered", recovered)
} finally {
  await bridge.close()
}
