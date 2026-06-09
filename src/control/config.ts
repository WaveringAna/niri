import { upsertAgent } from "./db"

type ConfiguredAgent = {
  id: string
  name?: string
  baseUrl: string
  token?: string
}

function parseConfiguredAgents(): ConfiguredAgent[] {
  const json = process.env.NIRI_AGENTS_JSON?.trim()
  if (json) {
    const parsed = JSON.parse(json) as ConfiguredAgent[]
    if (!Array.isArray(parsed)) throw new Error("NIRI_AGENTS_JSON must be an array")
    return parsed
  }

  const compact = process.env.NIRI_AGENTS?.trim()
  if (compact) {
    return compact
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [idPart, baseUrlPart] = entry.split("=", 2)
        const id = idPart?.trim() ?? ""
        const baseUrl = baseUrlPart?.trim() ?? ""
        if (!id || !baseUrl) throw new Error(`invalid NIRI_AGENTS entry: ${entry}`)
        return { id, baseUrl }
      })
  }

  const defaultUrl = process.env.NIRI_AGENT_URL?.trim()
  if (defaultUrl) {
    return [
      {
        id: process.env.NIRI_AGENT_ID?.trim() || "niri",
        baseUrl: defaultUrl,
      },
    ]
  }

  return []
}

export function registerConfiguredAgents(): void {
  for (const agent of parseConfiguredAgents()) {
    upsertAgent(agent)
    console.log(`[control] registered ${agent.id} -> ${agent.baseUrl}`)
  }
}
