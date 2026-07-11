/**
 * Cooldown channels — restrict when the agent is allowed to respond per channel.
 *
 * Driven by two env vars:
 *   COOLDOWN_CHANNELS  flat comma-separated triples: channelId,startHHMM,endHHMM
 *                      e.g. "91358921451,1700,2400,91358921452,900,1700"
 *   COOLDOWN_TZ        IANA timezone for the hours (e.g. "America/New_York");
 *                      falls back to the server's local timezone when unset.
 *
 * Hours are 24h HHMM (0900 = 9am, 1700 = 5pm, 2400 = end of day). A window
 * whose start >= end wraps past midnight (e.g. 2200,0200 = 10pm→2am).
 *
 * Outside a channel's window the bot still ingests messages for memory but
 * will not wake or reply. All helpers are cheap and read env at call time,
 * so config changes take effect without a restart.
 *
 * @module discord/cooldown
 */

export type CooldownWindow = { startMin: number; endMin: number }

/**
 * Parses a 3–4 digit HHMM token into minutes-of-day, or `null` when invalid.
 * Accepts 900 (09:00), 1700 (17:00), 2400 (24:00 = end of day).
 */
function parseHHMM(value: string): number | null {
  const s = value.trim()
  if (!/^\d{3,4}$/.test(s)) return null
  const hh = Number(s.slice(0, s.length - 2))
  const mm = Number(s.slice(-2))
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null
  if (hh === 24 && mm !== 0) return null // only 24:00 is valid
  return hh * 60 + mm
}

/**
 * Parses COOLDOWN_CHANNELS into a map of channel id → active window.
 *
 * @param input - Optional override; defaults to `process.env.COOLDOWN_CHANNELS`.
 * @returns Map of cooldown channel id to its active window (minutes-of-day).
 */
export function parseCooldownChannels(input?: string): Map<string, CooldownWindow> {
  const text = (input ?? process.env.COOLDOWN_CHANNELS ?? "").trim()
  const out = new Map<string, CooldownWindow>()
  if (!text) return out

  const parts = text.split(",").map((x) => x.trim()).filter(Boolean)
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const channelId = parts[i]
    const start = parseHHMM(parts[i + 1])
    const end = parseHHMM(parts[i + 2])
    if (!channelId || start === null || end === null) {
      console.warn(
        `[cooldown] skipping invalid window for channel ${channelId}: ${parts[i + 1]},${parts[i + 2]}`,
      )
      continue
    }
    out.set(channelId, { startMin: start, endMin: end })
  }

  if (parts.length % 3 !== 0) {
    console.warn(
      `[cooldown] COOLDOWN_CHANNELS has ${parts.length} value(s); expected multiples of 3 (channelId,start,end). Trailing entries ignored.`,
    )
  }
  return out
}

/** All channel ids that have a cooldown window configured. */
export function cooldownChannelIds(): string[] {
  return [...parseCooldownChannels().keys()]
}

/**
 * Current minute-of-day in the configured (COOLDOWN_TZ) timezone, or the
 * server's local timezone when unset/invalid.
 *
 * @param now - Optional override (mainly for tests).
 */
export function currentMinuteOfDay(now: Date = new Date()): number {
  const tz = (process.env.COOLDOWN_TZ ?? "").trim()
  if (!tz) return now.getHours() * 60 + now.getMinutes()
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now)
    let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0")
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0")
    if (Number.isNaN(hour) || Number.isNaN(minute)) return now.getHours() * 60 + now.getMinutes()
    if (hour === 24) hour = 0 // hour12:false can emit "24" at midnight in some runtimes
    return hour * 60 + minute
  } catch {
    // Invalid IANA timezone — fall back to local time.
    return now.getHours() * 60 + now.getMinutes()
  }
}

/** True when minute-of-day `min` falls within `w` (handles midnight wrap). */
function isWithinWindow(min: number, w: CooldownWindow): boolean {
  if (w.startMin === w.endMin) return true // empty/equal window => always active
  if (w.startMin < w.endMin) return min >= w.startMin && min < w.endMin
  // wraps past midnight (e.g. 22:00 → 02:00)
  return min >= w.startMin || min < w.endMin
}

/**
 * True if the channel is allowed to respond right now — always `true` for
 * channels with no cooldown config, otherwise true only within its window.
 *
 * @param channelId - Discord channel id.
 * @param now - Optional override (mainly for tests).
 */
export function isChannelActiveNow(channelId: string | null | undefined, now: Date = new Date()): boolean {
  if (!channelId) return true
  const w = parseCooldownChannels().get(channelId)
  if (!w) return true
  return isWithinWindow(currentMinuteOfDay(now), w)
}

/**
 * Cooldown channel ids whose active window is currently closed. Used to
 * suppress these from batch digests and auto-demotion.
 *
 * @param now - Optional override (mainly for tests).
 */
export function inactiveCooldownChannelIds(now: Date = new Date()): string[] {
  const min = currentMinuteOfDay(now)
  const out: string[] = []
  for (const [id, w] of parseCooldownChannels()) {
    if (!isWithinWindow(min, w)) out.push(id)
  }
  return out
}
