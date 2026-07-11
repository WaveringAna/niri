import { enqueueEvent, isRunning, wake } from "../runner/index"
import { fromDiscord } from "../triggers/discord"
import { isChannelActiveNow } from "./cooldown"
import { ingestDiscordEvent } from "./state"

const DISCORD_WAKE_ON_EVENT = (process.env.DISCORD_WAKE_ON_EVENT ?? "false").trim().toLowerCase() === "true"

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority" | "cooldown"
  note?: string
}

export function handleDiscordIngress(payload: unknown): DiscordIngressOutcome {
  const ingest = ingestDiscordEvent(payload)
  const isWakeEligible = ingest.isNew && !ingest.isFromSelf && Boolean(ingest.bucket)
  const wakeForDm = ingest.bucket === "dm"

  // Cooldown channels: keep ingesting for memory, but never wake outside the
  // configured active hours (even for @mentions; DMs bypass cooldowns).
  const outsideActiveHours = !wakeForDm && ingest.channelId != null && !isChannelActiveNow(ingest.channelId)
  if (isWakeEligible && outsideActiveHours) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "cooldown",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

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
  if (isRunning()) {
    enqueueEvent(event, { priority: wakeForDm })
  } else {
    void wake(event)
  }

  return {
    ingested: ingest.stored,
    woke: true,
    reason: wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
