import { stripVTControlCharacters } from "node:util"
import type { AgentSummary } from "./client.js"

/** Server strings reach the screen as data, never as control sequences. */
export const plain = (text: string): string => stripVTControlCharacters(text)
export const truncate = (text: string, width: number): string => {
  const clean = plain(text)
  return width <= 1 ? clean.slice(0, width) : clean.length <= width ? clean : `${clean.slice(0, width - 1)}\u2026`
}

/** Liveness as the view paints it: green running, red broken, yellow anything else. */
export type Tone = "ready" | "error" | "idle"
export const toneOf = (status: string): Tone =>
  /run|ready|active|online/i.test(status) ? "ready" : /error|fail|offline/i.test(status) ? "error" : "idle"

export type AgentRow = { id: string; label: string; status: string; model: string; revision: string; tone: Tone }

const status = (agent: AgentSummary): string => {
  const state = agent.application?.state
  return typeof state === "string" ? state : agent.status ?? "unknown"
}
const model = (agent: AgentSummary): string => {
  if (typeof agent.model === "string") return agent.model
  const named = (value: unknown): string | undefined =>
    value && typeof value === "object" && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string"
      ? (value as { name: string }).name
      : undefined
  return named(agent.model) ?? named(agent.config?.model) ?? "\u2014"
}
/** A pending application shows the crossing it is in the middle of: active\u2192desired. */
const revision = (agent: AgentSummary): string => {
  const active = agent.application?.activeRevision ?? agent.activeRevision
  const desired = agent.application?.desiredRevision ?? agent.revision
  return active !== undefined && desired !== undefined && active !== desired ? `${active}\u2192${desired}` : String(desired ?? active ?? "\u2014")
}

export const toRow = (agent: AgentSummary): AgentRow => ({
  id: agent.id,
  label: agent.name || agent.id,
  status: status(agent),
  model: model(agent),
  revision: revision(agent),
  tone: toneOf(status(agent)),
})

/** Tab-separated listing for pipes and non-terminal stdout. */
export const formatAgentList = (agents: AgentSummary[]): string =>
  agents.map((agent) => [agent.id, agent.name ?? "", status(agent), model(agent), revision(agent)].map(plain).join("\t")).join("\n")
