import path from "path"

/** Stable id used by the control plane to distinguish this worker. */
export const AGENT_ID = (process.env.NIRI_AGENT_ID ?? process.env.AGENT_ID ?? "niri").trim() || "niri"

/** Repository fallback home used when a local OS home is unavailable. */
export const REPO_HOME_DIR = path.resolve(process.cwd(), "home")

/**
 * Harness home for soul, memories, and local databases.
 *
 * This is intentionally independent from where model-facing tools execute.
 * Set NIRI_HOME on each worker VM to give that agent her own persistent home.
 */
export const NIRI_HOME = path.resolve(process.env.NIRI_HOME ?? process.env.HOME ?? REPO_HOME_DIR)
