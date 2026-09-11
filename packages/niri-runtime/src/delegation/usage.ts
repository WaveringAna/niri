import type OpenAI from "openai"

export type DelegatedTokenUsage = {
  cacheReadTokens: number
  uncachedInputTokens: number
  outputTokens: number
}

export const emptyDelegatedTokenUsage = (): DelegatedTokenUsage => ({
  cacheReadTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
})

const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0

export function addCompletionUsage(
  total: DelegatedTokenUsage,
  usage: OpenAI.Completions.CompletionUsage | undefined,
): DelegatedTokenUsage {
  if (!usage) return total
  const input = tokens(usage.prompt_tokens)
  const cacheRead = Math.min(input, tokens(usage.prompt_tokens_details?.cached_tokens))
  return {
    cacheReadTokens: total.cacheReadTokens + cacheRead,
    uncachedInputTokens: total.uncachedInputTokens + input - cacheRead,
    outputTokens: total.outputTokens + tokens(usage.completion_tokens),
  }
}

export const totalDelegatedTokens = (usage: DelegatedTokenUsage): number =>
  usage.cacheReadTokens + usage.uncachedInputTokens + usage.outputTokens

export const formatDelegatedTokenUsage = (usage: DelegatedTokenUsage): string =>
  `${usage.cacheReadTokens} cache read, ${usage.uncachedInputTokens} uncached input, ${usage.outputTokens} output tokens`
