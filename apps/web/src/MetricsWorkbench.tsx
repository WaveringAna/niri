import { useCallback, useEffect, useMemo, useState } from "react"
import { MarkdownBlock } from "./MarkdownBlock"

type Usage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

type BaseMetric = {
  id: number
  sourceType: string
  timestamp: string
  detailPath: string
}

type MemoryMetric = BaseMetric & {
  type: "memory"
  queryPreview?: string
  resultCount?: number
}

type PromptMetric = BaseMetric & {
  type: "prompt"
  messageCount?: number
  lastUserMessage?: string
}

type ResponseMetric = BaseMetric & {
  type: "response"
  promptMetricId?: number
  model?: string
  toolChoice?: string
  messageCount?: number
  lastUserMessage?: string
  responsePreview?: string
  toolCallCount?: number
  usage?: Usage
}

type UsageMetric = BaseMetric & {
  type: "usage"
  usage?: Usage
}

type SummarizationMetric = BaseMetric & {
  type: "summarization"
  method?: string
  before?: number
  after?: number
  savedTokens?: number
  summaryPreview?: string
  summaryChars?: number
}

type DiscordMetric = {
  id: string
  type: "discord"
  sourceType: "discord"
  timestamp: string
  detailPath: string
  messageId: string
  channelId: string
  guildId?: string
  authorUsername?: string
  contentPreview?: string
  isDm: boolean
  mentionsBot: boolean
  isFromBot: boolean
}

type MetricItem = MemoryMetric | PromptMetric | ResponseMetric | UsageMetric | SummarizationMetric

type MetricsPage = {
  memories: MemoryMetric[]
  summarization: SummarizationMetric[]
  response: ResponseMetric[]
  prompt: PromptMetric[]
  usage: UsageMetric[]
  discord: DiscordMetric[]
  limit: number
  nextCursor: Record<string, string | number | undefined>
  hasMore: Record<string, boolean | undefined>
}

type MetricsPageInput = Partial<MetricsPage>

type MemorySearchResult = {
  chunkId: number
  kind: string
  path: string
  source: string
  title: string
  headingPath: string | null
  preview: string
}

type MemoryDetail = {
  id: number
  type: "memory"
  timestamp: string
  query: string
  results: MemorySearchResult[]
}

type Message = {
  role?: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: unknown
}

type PromptDetail = {
  id: number
  type: "prompt" | "prompt_response"
  timestamp: string
  messages?: Message[]
  response?: Message
}

type TurnDetail = {
  id: number
  timestamp: string
  model?: string
  usage?: Usage
  promptText: string
  responseText?: string
  toolTraces: ToolTrace[]
}

type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; label: string }
  | { kind: "error"; text: string }
  | { kind: "memory"; memory: MemoryDetail; prompt?: PromptDetail }
  | { kind: "turn"; turn: TurnDetail }
  | { kind: "metric"; metric: unknown }

type MemoryPair = {
  memory: MemoryMetric
  prompt?: PromptMetric | ResponseMetric
  secondsApart?: number
  overlap: number
  shared: string[]
  issue: "ok" | "loose" | "missing"
}

type ToolTrace = {
  id: string
  name: string
  args: string
  result?: string
}

const baseUrl = import.meta.env.VITE_NIRI_BASE_URL ?? ""
const METRICS_POLL_INTERVAL_MS = 5_000

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "have",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
  "you",
  "your",
])

const formatNumber = (value: number | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "0"

const timeLabel = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

const shortTime = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
}

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? [record.text] : []
    })
    .join("\n")
}

const toolResultMarkdown = (result: string): string => {
  const trimmed = result.trim()
  if (!trimmed) return "```text\n(no output)\n```"
  if (/^(```|#{1,6}\s|- |\* |\d+\. |> |\|)/m.test(trimmed)) return trimmed
  return `\`\`\`text\n${trimmed}\n\`\`\``
}

const extractToolTraces = (prompt: PromptDetail | undefined): ToolTrace[] => {
  const messages = [...(prompt?.messages ?? []), ...(prompt?.response ? [prompt.response] : [])]
  const traces: ToolTrace[] = []
  const byId = new Map<string, ToolTrace>()

  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue
        const call = rawCall as Record<string, unknown>
        const fn = call.function && typeof call.function === "object" ? (call.function as Record<string, unknown>) : {}
        const id = typeof call.id === "string" ? call.id : `tool-${traces.length + 1}`
        const trace: ToolTrace = {
          id,
          name: typeof fn.name === "string" ? fn.name : "tool",
          args: typeof fn.arguments === "string" ? fn.arguments : "",
        }
        traces.push(trace)
        byId.set(id, trace)
      }
    }

    if (message.role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      const result = textContent(message.content)
      const existing = byId.get(id)
      if (existing) {
        existing.result = result
      } else {
        traces.push({
          id: id || `tool-result-${traces.length + 1}`,
          name: "tool result",
          args: "",
          result,
        })
      }
    }
  }

  return traces
}

const lastUserMessage = (messages: Message[] | undefined): string => {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "user") {
      const text = textContent(message.content).trim()
      if (text) return text
    }
  }
  return ""
}

const tokens = (value: string | undefined): string[] => {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => token.length > 2 && !stopWords.has(token))
}

const overlapFor = (left: string | undefined, right: string | undefined): { score: number; shared: string[] } => {
  const leftTokens = new Set(tokens(left))
  const rightTokens = new Set(tokens(right))
  if (leftTokens.size === 0 || rightTokens.size === 0) return { score: 0, shared: [] }

  const shared = [...leftTokens].filter((token) => rightTokens.has(token))
  return {
    score: shared.length / Math.max(1, Math.min(leftTokens.size, rightTokens.size)),
    shared: shared.slice(0, 8),
  }
}

const fetchJson = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const res = await fetch(`${baseUrl}${path}`, { signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim())
  return (await res.json()) as T
}

const normalizeMetricsPage = (page: MetricsPageInput): MetricsPage => ({
  memories: Array.isArray(page.memories) ? page.memories : [],
  summarization: Array.isArray(page.summarization) ? page.summarization : [],
  response: Array.isArray(page.response) ? page.response : [],
  prompt: Array.isArray(page.prompt) ? page.prompt : [],
  usage: Array.isArray(page.usage) ? page.usage : [],
  discord: Array.isArray(page.discord) ? page.discord : [],
  limit: typeof page.limit === "number" ? page.limit : 100,
  nextCursor: page.nextCursor ?? {},
  hasMore: page.hasMore ?? {},
})

function buildMetricsUrl(search: string): string {
  const params = new URLSearchParams()
  params.set("limit", "100")
  if (search.trim()) params.set("q", search.trim())
  return `/metrics?${params.toString()}`
}

function closestResponsePath(timestamp: string, responses: ResponseMetric[]): string | undefined {
  const usageTime = new Date(timestamp).getTime()
  if (!Number.isFinite(usageTime)) return undefined

  let best: ResponseMetric | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const r of responses) {
    const t = new Date(r.timestamp).getTime()
    if (!Number.isFinite(t) || t > usageTime) continue
    const delta = usageTime - t
    if (delta < bestDelta) {
      best = r
      bestDelta = delta
    }
  }
  return best?.detailPath
}

function TokenTrace({
  usage,
  responses,
  onOpenTurn,
  latestPromptText,
}: {
  usage: UsageMetric[]
  responses: ResponseMetric[]
  onOpenTurn: (path: string) => void
  latestPromptText?: string
}) {
  const points = useMemo(() => {
    const usagePoints = usage.map((item) => ({
      id: `u-${item.id}`,
      timestamp: item.timestamp,
      usage: item.usage,
      model: undefined as string | undefined,
      detailPath: closestResponsePath(item.timestamp, responses) ?? item.detailPath,
    }))
    const responsePoints = responses
      .filter((item) => item.usage)
      .map((item) => ({
        id: `r-${item.id}`,
        timestamp: item.timestamp,
        usage: item.usage,
        model: item.model,
        detailPath: item.detailPath,
      }))
    return [...usagePoints, ...responsePoints]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-80)
  }, [responses, usage])

  const maxTotal = Math.max(1, ...points.map((point) => point.usage?.total_tokens ?? 0))
  const latest = points[points.length - 1]
  const totals = points.reduce(
    (sum, point) => ({
      prompt: sum.prompt + (point.usage?.prompt_tokens ?? 0),
      completion: sum.completion + (point.usage?.completion_tokens ?? 0),
      total: sum.total + (point.usage?.total_tokens ?? 0),
    }),
    { prompt: 0, completion: 0, total: 0 },
  )
  const average = points.length ? Math.round(totals.total / points.length) : 0

  return (
    <section className="metric-panel metric-token-panel" aria-label="token usage">
      <div className="panel-head">
        <div>
          <h2>Token Usage</h2>
          <p>{points.length ? `${points.length} recent completions` : "No usage rows yet"}</p>
        </div>
        <div className="token-readout">
          <span>{formatNumber(latest?.usage?.total_tokens)}</span>
          <small>latest total</small>
        </div>
      </div>

      <div className="token-strip" aria-label="recent token totals">
        {points.map((point) => {
          const prompt = point.usage?.prompt_tokens ?? 0
          const completion = point.usage?.completion_tokens ?? 0
          const total = point.usage?.total_tokens ?? prompt + completion
          return (
            <button
              key={point.id}
              className="token-bar"
              type="button"
              onClick={() => onOpenTurn(point.detailPath)}
              title={`${timeLabel(point.timestamp)} total ${formatNumber(total)} prompt ${formatNumber(prompt)} completion ${formatNumber(completion)}`}
              style={{ height: `${Math.max(8, Math.round((total / maxTotal) * 100))}%` }}
            >
              <span className="token-bar-prompt" style={{ height: `${total ? (prompt / total) * 100 : 0}%` }} />
              <span className="token-bar-completion" style={{ height: `${total ? (completion / total) * 100 : 0}%` }} />
            </button>
          )
        })}
      </div>

      <div className="token-ledger">
        <div>
          <span>{formatNumber(totals.prompt)}</span>
          <small>prompt</small>
        </div>
        <div>
          <span>{formatNumber(totals.completion)}</span>
          <small>completion</small>
        </div>
        <div>
          <span>{formatNumber(average)}</span>
          <small>avg total</small>
        </div>
      </div>

      {latestPromptText && (
        <div className="latest-prompt">
          <small>latest prompt</small>
          <p>{latestPromptText}</p>
        </div>
      )}
    </section>
  )
}

function MemoryReview({
  pairs,
  selectedId,
  reviewOnly,
  onReviewOnlyChange,
  onSelect,
}: {
  pairs: MemoryPair[]
  selectedId?: number
  reviewOnly: boolean
  onReviewOnlyChange: (value: boolean) => void
  onSelect: (pair: MemoryPair) => void
}) {
  const visible = reviewOnly ? pairs.filter((pair) => pair.issue !== "ok") : pairs

  return (
    <section className="metric-panel memory-panel" aria-label="memory prompt alignment">
      <div className="panel-head">
        <div>
          <h2>Memory Fit</h2>
          <p>{visible.length} recalls matched against nearby prompts</p>
        </div>
        <label className="switch-row">
          <input type="checkbox" checked={reviewOnly} onChange={(event) => onReviewOnlyChange(event.target.checked)} />
          review only
        </label>
      </div>

      <div className="memory-table" role="table">
        <div className="memory-row memory-row-head" role="row">
          <span>time</span>
          <span>fit</span>
          <span>memory query</span>
          <span>near prompt</span>
        </div>
        {visible.map((pair) => (
          <button
            key={pair.memory.id}
            type="button"
            className={`memory-row ${selectedId === pair.memory.id ? "is-selected" : ""} issue-${pair.issue}`}
            onClick={() => onSelect(pair)}
            role="row"
          >
            <span>{shortTime(pair.memory.timestamp)}</span>
            <span>
              {pair.issue === "missing" ? "no prompt" : `${Math.round(pair.overlap * 100)}%`}
              {pair.secondsApart != null ? <small>{Math.abs(pair.secondsApart)}s</small> : null}
            </span>
            <span>{pair.memory.queryPreview ?? "empty memory query"}</span>
            <span>{pair.prompt?.lastUserMessage ?? "no matching prompt"}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function DetailPane({ detail }: { detail: DetailState }) {
  if (detail.kind === "idle") {
    return (
      <aside className="detail-pane">
        <h2>Turn Detail</h2>
        <p>Click a bar in the chart or a response in the rail to inspect the turn.</p>
      </aside>
    )
  }

  if (detail.kind === "loading") {
    return (
      <aside className="detail-pane">
        <h2>{detail.label}</h2>
        <p>Loading.</p>
      </aside>
    )
  }

  if (detail.kind === "error") {
    return (
      <aside className="detail-pane detail-error">
        <h2>Error</h2>
        <p>{detail.text}</p>
      </aside>
    )
  }

  if (detail.kind === "turn") {
    const { turn } = detail
    return (
      <aside className="detail-pane">
        <h2>Turn #{turn.id}</h2>
        <dl className="detail-meta">
          {turn.model ? <div><dt>model</dt><dd>{turn.model}</dd></div> : null}
          <div><dt>time</dt><dd>{timeLabel(turn.timestamp)}</dd></div>
          {turn.usage ? (
            <>
              <div><dt>prompt</dt><dd>{formatNumber(turn.usage.prompt_tokens)} tok</dd></div>
              <div><dt>completion</dt><dd>{formatNumber(turn.usage.completion_tokens)} tok</dd></div>
            </>
          ) : null}
        </dl>

        <section className="detail-section">
          <h3>Prompt</h3>
          <MarkdownBlock content={turn.promptText || "(no prompt)"} />
        </section>

        {turn.toolTraces.length > 0 ? (
          <section className="detail-section">
            <h3>Tool Calls ({turn.toolTraces.length})</h3>
            <div className="tool-trace-list">
              {turn.toolTraces.map((tool) => (
                <article key={tool.id} className="tool-trace">
                  <details>
                    <summary>
                      <span>{tool.name}</span>
                      <small>{tool.id}</small>
                    </summary>
                    {tool.args ? <pre className="tool-args">{tool.args}</pre> : null}
                    {tool.result !== undefined ? (
                      <div className="tool-result">
                        <MarkdownBlock content={toolResultMarkdown(tool.result)} />
                      </div>
                    ) : null}
                  </details>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {turn.responseText ? (
          <section className="detail-section">
            <h3>Response</h3>
            <MarkdownBlock content={turn.responseText} />
          </section>
        ) : null}
      </aside>
    )
  }

  if (detail.kind === "metric") {
    return (
      <aside className="detail-pane">
        <h2>Metric Detail</h2>
        <pre>{JSON.stringify(detail.metric, null, 2)}</pre>
      </aside>
    )
  }

  const promptText = lastUserMessage(detail.prompt?.messages)

  return (
    <aside className="detail-pane">
      <h2>Recall #{detail.memory.id}</h2>
      <dl className="detail-meta">
        <div>
          <dt>time</dt>
          <dd>{timeLabel(detail.memory.timestamp)}</dd>
        </div>
        <div>
          <dt>chunks</dt>
          <dd>{detail.memory.results.length}</dd>
        </div>
      </dl>

      <section className="detail-section">
        <h3>Prompt</h3>
        <MarkdownBlock content={promptText || detail.memory.query} />
      </section>

      <section className="detail-section">
        <h3>Memory Query</h3>
        <MarkdownBlock content={detail.memory.query} />
      </section>

      <section className="detail-section">
        <h3>Retrieved Chunks</h3>
        {detail.memory.results.map((result) => (
          <article key={result.chunkId} className="memory-hit">
            <div>
              <strong>{result.title}</strong>
              <span>{result.kind} / {result.source}</span>
            </div>
            <p>{result.preview}</p>
          </article>
        ))}
      </section>
    </aside>
  )
}

function BucketRail({
  metrics,
  onOpenMetric,
}: {
  metrics: MetricsPage
  onOpenMetric: (path: string) => void
}) {
  const rows: Array<{ label: string; count: number; items: Array<MetricItem | DiscordMetric> }> = [
    { label: "response", count: metrics.response.length, items: metrics.response.slice(0, 6) },
    { label: "summarization", count: metrics.summarization.length, items: metrics.summarization.slice(0, 6) },
    { label: "discord", count: metrics.discord.length, items: metrics.discord.slice(0, 6) },
  ]

  return (
    <section className="bucket-rail" aria-label="raw metric buckets">
      {rows.map((bucket) => (
        <section key={bucket.label}>
          <header>
            <h3>{bucket.label}</h3>
            <span>{bucket.count}</span>
          </header>
          <div className="bucket-list">
            {bucket.items.map((item) => (
              <button key={`${item.type}-${item.id}`} type="button" onClick={() => onOpenMetric(item.detailPath)}>
                <span>{shortTime(item.timestamp)}</span>
                <strong>
                  {item.type === "response"
                    ? item.responsePreview || `${item.model ?? "model"}`
                    : item.type === "summarization"
                      ? item.summaryPreview || item.method || "summary"
                      : item.type === "discord"
                        ? item.contentPreview || item.authorUsername || "discord"
                        : item.type}
                </strong>
              </button>
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}

export function MetricsWorkbench() {
  const [metrics, setMetrics] = useState<MetricsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [reviewOnly, setReviewOnly] = useState(false)
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" })
  const [live, setLive] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const loadMetrics = useCallback((signal?: AbortSignal, options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true)
    setError(null)
    fetchJson<MetricsPageInput>(buildMetricsUrl(query), signal)
      .then((page) => {
        setMetrics(normalizeMetricsPage(page))
        setLastUpdated(new Date().toISOString())
      })
      .catch((err) => {
        if (signal?.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false)
      })
  }, [query])

  useEffect(() => {
    const controller = new AbortController()
    loadMetrics(controller.signal)
    let interval: ReturnType<typeof setInterval> | undefined
    let pollController: AbortController | null = null

    if (live) {
      interval = setInterval(() => {
        pollController?.abort()
        pollController = new AbortController()
        loadMetrics(pollController.signal, { silent: true })
      }, METRICS_POLL_INTERVAL_MS)
    }

    return () => {
      controller.abort()
      pollController?.abort()
      if (interval) clearInterval(interval)
    }
  }, [live, loadMetrics])

  const pairs = useMemo<MemoryPair[]>(() => {
    if (!metrics) return []
    const prompts = [...metrics.response, ...metrics.prompt]
      .filter((prompt) => prompt.lastUserMessage)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    return metrics.memories.map((memory) => {
      const memoryTime = new Date(memory.timestamp).getTime()
      const prompt = prompts.find((item) => new Date(item.timestamp).getTime() >= memoryTime) ?? prompts[prompts.length - 1]
      const promptTime = prompt ? new Date(prompt.timestamp).getTime() : Number.NaN
      const secondsApart = prompt && Number.isFinite(promptTime) ? Math.round((promptTime - memoryTime) / 1000) : undefined
      const overlap = overlapFor(memory.queryPreview, prompt?.lastUserMessage)
      const issue = !prompt ? "missing" : overlap.score < 0.16 ? "loose" : "ok"
      return { memory, prompt, secondsApart, overlap: overlap.score, shared: overlap.shared, issue }
    })
  }, [metrics])

  const latestPromptText = useMemo(() => {
    return metrics?.response[0]?.lastUserMessage ?? undefined
  }, [metrics])

  const selectedMemoryId = detail.kind === "memory" ? detail.memory.id : undefined

  const selectPair = useCallback(async (pair: MemoryPair) => {
    setDetail({ kind: "loading", label: `Recall #${pair.memory.id}` })
    try {
      const [memory, prompt] = await Promise.all([
        fetchJson<MemoryDetail>(pair.memory.detailPath),
        pair.prompt ? fetchJson<PromptDetail>(pair.prompt.detailPath) : Promise.resolve(undefined),
      ])
      setDetail({ kind: "memory", memory, prompt })
    } catch (err) {
      setDetail({ kind: "error", text: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const openMetric = useCallback(async (path: string) => {
    setDetail({ kind: "loading", label: "Turn detail" })
    try {
      const raw = await fetchJson<Record<string, unknown>>(path)
      if (raw?.type === "prompt_response") {
        const msgs = Array.isArray(raw.messages) ? (raw.messages as Message[]) : []
        const response = raw.response as Message | undefined
        const promptText = lastUserMessage(msgs)
        const responseText = textContent(response?.content) || undefined
        const fakeDetail: PromptDetail = {
          id: raw.id as number,
          type: "prompt_response",
          timestamp: raw.timestamp as string,
          messages: msgs,
          response,
        }
        setDetail({
          kind: "turn",
          turn: {
            id: raw.id as number,
            timestamp: raw.timestamp as string,
            model: typeof raw.model === "string" ? raw.model : undefined,
            usage: raw.usage as Usage | undefined,
            promptText: promptText || "(no prompt)",
            responseText,
            toolTraces: extractToolTraces(fakeDetail),
          },
        })
      } else {
        setDetail({ kind: "metric", metric: raw })
      }
    } catch (err) {
      setDetail({ kind: "error", text: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  return (
    <main className="metrics-app">
      <header className="metrics-header">
        <div>
          <h1>Metrics</h1>
          <p>Token pressure and memory retrieval checks.</p>
        </div>
        <form
          className="metrics-search"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(search.trim())
          }}
        >
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="filter metrics" aria-label="filter metrics" />
          <button type="submit">filter</button>
          <button type="button" onClick={() => loadMetrics()}>
            refresh
          </button>
          <button type="button" onClick={() => {
            setSearch("")
            setQuery("")
          }}>
            clear
          </button>
        </form>
        <div className="live-controls">
          <button type="button" className={live ? "is-live" : ""} onClick={() => setLive((value) => !value)}>
            {live ? "live" : "paused"}
          </button>
          <span>{lastUpdated ? `updated ${shortTime(lastUpdated)}` : "not updated yet"}</span>
        </div>
      </header>

      {error ? <p className="metrics-error">metrics unavailable: {error}</p> : null}
      {loading && !metrics ? <p className="metrics-loading">loading metrics</p> : null}

      {metrics ? (
        <div className="metrics-grid">
          <div className="metrics-main">
            <TokenTrace
              usage={metrics.usage}
              responses={metrics.response}
              onOpenTurn={openMetric}
              latestPromptText={latestPromptText}
            />
            <MemoryReview
              pairs={pairs}
              selectedId={selectedMemoryId}
              reviewOnly={reviewOnly}
              onReviewOnlyChange={setReviewOnly}
              onSelect={selectPair}
            />
          </div>
          <div className="metrics-side">
            <DetailPane detail={detail} />
            <BucketRail metrics={metrics} onOpenMetric={openMetric} />
          </div>
        </div>
      ) : null}
    </main>
  )
}
