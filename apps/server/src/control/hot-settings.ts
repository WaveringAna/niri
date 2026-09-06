/**
 * Which flattened worker settings can change without replacing the worker.
 *
 * This is an allowlist, and it is evidence-based: a key belongs here only when
 * the runtime reads it per use or registers a reload hook for it. Anything not
 * listed — including anything new — is cold, so an unclassified setting costs a
 * restart rather than silently drifting from the durable config.
 */
export const HOT_SETTINGS: ReadonlySet<string> = new Set([
  // read per use by the Discord pipeline
  "DISCORD_DM_WHITELIST",
  "DISCORD_POSTURE_BYPASS",
  "DISCORD_SCAN_CHANNEL_IDS",
  "DISCORD_BATCH_ONLY_CONFIGURED",
  "DISCORD_PENDING_AUTO_SEEN_MINUTES",
  "COOLDOWN_CHANNELS",
  "COOLDOWN_TZ",
  // read per use, plus a hook that repaints the Discord presence
  "DISCORD_POSTURES",
  // read when the digest timer fires, plus a hook that restarts it
  "DISCORD_BATCH_INTERVAL_MS",
  "DISCORD_BATCH_MAX_MESSAGES",
  "DISCORD_BATCH_SCAN",
])

/**
 * Cold on purpose, with the reason, so the next person extending the list knows
 * what they are taking on:
 *
 * - DISCORD_BOT_TOKEN, DISCORD_BOT_USER_ID, DISCORD_GATEWAY_ENABLED — gateway
 *   identity and lifetime; a change means a reconnect, which worker replacement
 *   already does well. A future reconnect hook could make these hot.
 * - MODEL, OPENAI_*, ANTHROPIC_*, FALLBACK_*, SUMMARY_*, ENABLE_THINKING,
 *   *_TOOL_CHOICE — resolved once into module constants in runner/util.ts and
 *   re-exported; hot swapping needs those constants to become getters first.
 * - EMBEDDING_* — vector tables are built for one embedding model and width.
 * - CONTEXT_COMPACT_*, LCM_SUMMARY_BATCH_SIZE, IMAGE_TOOL_MAX_BYTES — read in
 *   some paths and captured at import in others; ambiguous means cold.
 * - NIRI_MCP_CONFIG, NIRI_DELEGATION_CONFIG — spawn transports and profiles.
 * - PORT, HOME, NIRI_HOME, NIRI_CLIENT, NIRI_CLIENT_WORKSPACE, NIRI_SERVER_IROH_* —
 *   process identity and transports.
 */
export type SettingsDelta = Record<string, string | null>

/** Keys whose value differs between two flattened environments, in a stable order. */
export function settingsDelta(before: NodeJS.ProcessEnv, after: NodeJS.ProcessEnv): SettingsDelta {
  const delta: SettingsDelta = {}
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[key] === after[key]) continue
    delta[key] = after[key] ?? null
  }
  return delta
}

export const coldKeys = (delta: SettingsDelta): string[] => Object.keys(delta).filter((key) => !HOT_SETTINGS.has(key))
