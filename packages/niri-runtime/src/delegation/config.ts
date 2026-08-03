export type DelegationToolName = "shell" | "read_file" | "edit_file" | "image_tool"

export type DelegationProfile = {
  name: string
  model?: string
  systemPrompt: string
  tools: DelegationToolName[]
  mcpTools: string[]
  maxTurns: number
}

export type DelegationConfig = {
  enabled: boolean
  maxConcurrent: number
  timeoutMs: number
  resultMaxChars: number
  profiles: DelegationProfile[]
}

const KNOWN_TOOLS = new Set<DelegationToolName>(["shell", "read_file", "edit_file", "image_tool"])

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function loadConfig(): DelegationConfig {
  const raw = process.env.NIRI_DELEGATION_CONFIG?.trim()
  if (!raw) {
    return { enabled: false, maxConcurrent: 2, timeoutMs: 30 * 60_000, resultMaxChars: 6000, profiles: [] }
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : []
  const profiles = rawProfiles.flatMap((value): DelegationProfile[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const name = typeof item.name === "string" ? item.name.trim() : ""
    if (!name) return []
    const tools = Array.isArray(item.tools)
      ? [...new Set(item.tools.filter((tool): tool is DelegationToolName => typeof tool === "string" && KNOWN_TOOLS.has(tool as DelegationToolName)))]
      : []
    if (tools.length === 0) return []
    const mcpTools = Array.isArray(item.mcpTools)
      ? [...new Set(item.mcpTools.filter((tool): tool is string => typeof tool === "string" && /^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(tool) && tool.length <= 64))]
      : []
    return [{
      name,
      ...(typeof item.model === "string" && item.model.trim() ? { model: item.model.trim() } : {}),
      systemPrompt: typeof item.systemPrompt === "string" ? item.systemPrompt.trim() : "",
      tools,
      mcpTools,
      maxTurns: positiveInteger(item.maxTurns, 30),
    }]
  })

  return {
    enabled: parsed.enabled !== false && profiles.length > 0,
    maxConcurrent: Math.min(8, positiveInteger(parsed.maxConcurrent, 2)),
    timeoutMs: Math.max(1000, positiveInteger(parsed.timeoutMs, 30 * 60_000)),
    resultMaxChars: Math.max(1000, positiveInteger(parsed.resultMaxChars, 6000)),
    profiles,
  }
}

export const delegationConfig = loadConfig()

export function findDelegationProfile(name: string): DelegationProfile | undefined {
  return delegationConfig.profiles.find((profile) => profile.name === name)
}
