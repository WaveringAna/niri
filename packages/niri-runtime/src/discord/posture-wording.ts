/**
 * Posture wording: the runtime owns what a posture *does*, the agent owns what
 * it *says*. Every string here comes from `discord.postures` in the agent's own
 * config (flattened into DISCORD_POSTURES); the code defaults describe the
 * mechanism and carry no persona.
 *
 * @module discord/posture-wording
 */

export type PostureWording = { description?: string; guidance?: string; bio?: string; reminder?: string }

const FIELDS = ["description", "guidance", "bio", "reminder"] as const

/** Neutral status text used until an agent writes its own. */
const DEFAULT_BIO: Record<string, string> = {
  hearth: "around — say hi.",
  forge: "heads down building; your messages are safe and i will find them.",
}

/** Mechanical nudge; an agent replaces it with `postures.forge.reminder`. */
export const DEFAULT_FORGE_REMINDER = "you've been in forge for 2 hours, check your queue?"

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined

/** Lenient on the worker side: the strict contract is enforced when the config is parsed. */
export function configuredPostures(): Record<string, PostureWording> {
  const raw = process.env.DISCORD_POSTURES?.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object of posture names")
    const postures: Record<string, PostureWording> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (!/^[a-z0-9_-]+$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) continue
      const fields = Object.fromEntries(FIELDS.flatMap((field) => {
        const found = text((value as Record<string, unknown>)[field])
        return found ? [[field, found] as const] : []
      }))
      if (Object.keys(fields).length > 0) postures[name] = fields
    }
    return postures
  } catch (err) {
    console.warn(`[posture] invalid DISCORD_POSTURES: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

export const postureWording = (name: string): PostureWording => configuredPostures()[name] ?? {}

/** The status line Discord shows; configured wording wins, then the neutral default. */
export const postureBio = (name: string): string => postureWording(name).bio ?? DEFAULT_BIO[name] ?? ""

export const postureReminder = (name: string): string => postureWording(name).reminder ?? DEFAULT_FORGE_REMINDER
