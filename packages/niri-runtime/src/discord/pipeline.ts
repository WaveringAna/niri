import { enqueueEvent, isRunning, wake } from "../runner/index"
import { fromDiscord } from "../triggers/discord"
import { isChannelActiveNow } from "./cooldown"
import { updateInboxItem } from "./db"
import { getPosture, isPostureBypass } from "./posture"
import { ingestDiscordEvent } from "./state"

const DISCORD_WAKE_ON_EVENT = (process.env.DISCORD_WAKE_ON_EVENT ?? "false").trim().toLowerCase() === "true"

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority" | "cooldown" | "forge" | "posture_bypass"
  note?: string
}

export function handleDiscordIngress(payload: unknown): DiscordIngressOutcome {
  const ingest = ingestDiscordEvent(payload)
  const posture = getPosture()
  const inForge = posture === "forge"
  const postureBypass = isPostureBypass(ingest.authorId, ingest.channelId)
  const isWakeEligible =
    ingest.isNew &&
    !ingest.isFromSelf &&
    (Boolean(ingest.bucket) || (inForge && postureBypass))
  const wakeForDm = ingest.bucket === "dm"

  if (inForge && !postureBypass && isWakeEligible && ingest.itemId) {
    updateInboxItem(ingest.itemId, "queued", "none", "queued during forge")
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "forge",
      note: "Discord event held until hearth",
    }
  }

  // Cooldown channels: keep ingesting for memory, but never wake outside the
  // configured active hours (even for @mentions; DMs bypass cooldowns).
  const outsideActiveHours =
    !wakeForDm && !postureBypass && ingest.channelId != null && !isChannelActiveNow(ingest.channelId)
  if (isWakeEligible && outsideActiveHours) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "cooldown",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  const shouldWake = isWakeEligible && (DISCORD_WAKE_ON_EVENT || wakeForDm || (inForge && postureBypass))

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
    enqueueEvent(event, { priority: wakeForDm || postureBypass })
  } else {
    void wake(event)
  }

  return {
    ingested: ingest.stored,
    woke: true,
    reason: inForge && postureBypass ? "posture_bypass" : wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
