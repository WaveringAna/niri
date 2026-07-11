import { getDb } from "../db"

export function formatPronounSets(sets: string[]): string {
  if (sets.length === 0) return ""
  if (sets.length === 1) {
    const single = sets[0]
    switch (single) {
      case "he": return "he/him"
      case "she": return "she/her"
      case "they": return "they/them"
      case "it": return "it/its"
      case "any": return "any"
      case "ask": return "ask me"
      case "avoid": return "avoid pronouns"
      case "other": return "other"
      default: return single
    }
  }
  return sets.map(s => {
    switch (s) {
      case "he": return "he"
      case "she": return "she"
      case "they": return "they"
      case "it": return "it"
      case "any": return "any"
      case "ask": return "ask me"
      case "avoid": return "avoid"
      case "other": return "other"
      default: return s
    }
  }).join("/")
}

export function getCachedPronouns(userId: string): string | null {
  try {
    const db = getDb()
    const row = db.prepare("select pronouns from discord_user_pronouns where user_id = ?").get(userId) as { pronouns?: string } | undefined
    return row?.pronouns || null
  } catch (err) {
    return null
  }
}

export async function maybeFetchAndCachePronouns(userId: string): Promise<void> {
  if (!userId) return

  const db = getDb()
  const now = new Date()

  // Check if we already have pronouns and they are fresh (less than 24 hours old)
  try {
    const row = db.prepare("select updated_at from discord_user_pronouns where user_id = ?").get(userId) as { updated_at?: string } | undefined
    if (row?.updated_at) {
      const updatedAt = new Date(row.updated_at)
      const diffMs = now.getTime() - updatedAt.getTime()
      const diffHours = diffMs / (1000 * 60 * 60)
      if (diffHours < 24) {
        return
      }
    }
  } catch (err) {
    // Continue if query fails
  }

  // Fetch from PronounDB
  try {
    const url = `https://pronoundb.org/api/v2/lookup?platform=discord&ids=${userId}`
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Niri/1.0.0 (https://github.com/niri-org/niri)"
      }
    })

    let pronouns = ""
    if (res.ok) {
      const data = await res.json() as Record<string, { sets: { en?: string[] } }>
      const userPr = data[userId]
      if (userPr && userPr.sets && userPr.sets.en) {
        pronouns = formatPronounSets(userPr.sets.en)
      }
    }

    db.prepare(
      `insert into discord_user_pronouns (user_id, pronouns, updated_at)
       values (?, ?, ?)
       on conflict(user_id) do update set
         pronouns = excluded.pronouns,
         updated_at = excluded.updated_at`
    ).run(userId, pronouns, now.toISOString())
  } catch (err) {
    console.error(`[pronouns] failed to fetch/cache pronouns for user ${userId}:`, err)
  }
}
