import { enqueueEvent, isRunning, wake } from "../runner/index.js"
import { fromDiscord } from "../triggers/discord.js"
import { ingestDiscordEvent } from "./state.js"

const DISCORD_WAKE_ON_EVENT = (process.env.DISCORD_WAKE_ON_EVENT ?? "false").trim().toLowerCase() === "true"
const DISCORD_WAKE_ON_DM = (process.env.DISCORD_WAKE_ON_DM ?? "true").trim().toLowerCase() !== "false"

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority"
  note?: string
}

export function handleDiscordIngress(payload: unknown): DiscordIngressOutcome {
  const ingest = ingestDiscordEvent(payload)
  const isWakeEligible = ingest.isNew && !ingest.isFromSelf && Boolean(ingest.bucket)
  const wakeForDm = DISCORD_WAKE_ON_DM && ingest.bucket === "dm"
  const shouldWake = isWakeEligible && (DISCORD_WAKE_ON_EVENT || wakeForDm)

  if (!shouldWake) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "ingest_only",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  const event = fromDiscord(payload)
  isRunning() ? enqueueEvent(event) : wake(event)

  return {
    ingested: ingest.stored,
    woke: true,
    reason: wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
