import OpenAI from "openai"
import { MEMORY_EMBEDDING_DIMENSIONS } from "./db"
import { openAIHeaders, openAIUserAgent } from "./openai-headers"

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "google/gemini-embedding-2-preview"
export const EMBEDDING_DIMENSIONS = parseInt(
  process.env.EMBEDDING_DIMENSIONS ?? String(MEMORY_EMBEDDING_DIMENSIONS),
  10,
)

const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL ?? "https://openrouter.ai/api/v1"
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY
const embeddingHeaders = openAIHeaders([
  ["HTTP-Referer", process.env.EMBEDDING_OPENAI_REFERER],
  ["X-Title", process.env.EMBEDDING_TITLE],
  ["User-Agent", openAIUserAgent(process.env.EMBEDDING_OPENAI_USER_AGENT)],
])

const embeddingClient = EMBEDDING_API_KEY
  ? new OpenAI({
      baseURL: EMBEDDING_BASE_URL,
      apiKey: EMBEDDING_API_KEY,
      defaultHeaders: embeddingHeaders,
    })
  : null

export function embeddingsConfigured(): boolean {
  return Boolean(embeddingClient) && EMBEDDING_DIMENSIONS > 0
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddingClient || texts.length === 0) return []

  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
    encoding_format: "float",
  })

  if (!Array.isArray(response.data)) {
    const keys = response && typeof response === "object" ? Object.keys(response).join(",") : typeof response
    throw new Error(`embedding response missing data array (model=${EMBEDDING_MODEL}, inputs=${texts.length}, keys=${keys || "none"})`)
  }

  return response.data.map((item) => item.embedding)
}
