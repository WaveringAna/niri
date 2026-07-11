import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { initDb, getDb } from "../db"
import { formatPronounSets, getCachedPronouns, maybeFetchAndCachePronouns } from "./pronouns"

test("pronouns formatting tests", () => {
  // Test single sets
  assert.equal(formatPronounSets(["he"]), "he/him")
  assert.equal(formatPronounSets(["she"]), "she/her")
  assert.equal(formatPronounSets(["they"]), "they/them")
  assert.equal(formatPronounSets(["it"]), "it/its")
  assert.equal(formatPronounSets(["any"]), "any")
  assert.equal(formatPronounSets(["ask"]), "ask me")
  assert.equal(formatPronounSets(["avoid"]), "avoid pronouns")
  assert.equal(formatPronounSets(["other"]), "other")

  // Test compound sets
  assert.equal(formatPronounSets(["she", "they"]), "she/they")
  assert.equal(formatPronounSets(["he", "they"]), "he/they")
  assert.equal(formatPronounSets(["she", "it"]), "she/it")
  assert.equal(formatPronounSets(["any", "ask"]), "any/ask me")
})

test("pronouns database caching tests", async () => {
  // Create a temp directory for the test DB
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "niri-test-"))
  const originalHome = process.env.NIRI_HOME
  process.env.NIRI_HOME = tempDir

  try {
    initDb()

    const db = getDb()

    // Clean up any potential leftover test users to prevent constraint violations
    db.prepare("delete from discord_user_pronouns where user_id in (?, ?)").run("user1", "user2")

    // Seed some data directly
    db.prepare(
      "insert into discord_user_pronouns (user_id, pronouns, updated_at) values (?, ?, ?)"
    ).run("user1", "she/they", new Date().toISOString())

    // Get cached pronouns
    assert.equal(getCachedPronouns("user1"), "she/they")
    assert.equal(getCachedPronouns("user-nonexistent"), null)

    // Mock fetch for maybeFetchAndCachePronouns
    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = async (url: string | URL | Request) => {
      fetchCalled = true
      assert.match(String(url), /ids=user2/)
      return {
        ok: true,
        json: async () => ({
          user2: {
            sets: {
              en: ["he", "they"]
            }
          }
        })
      } as any
    }

    try {
      await maybeFetchAndCachePronouns("user2")
      assert.equal(fetchCalled, true)
      assert.equal(getCachedPronouns("user2"), "he/they")
    } finally {
      globalThis.fetch = originalFetch
    }

  } finally {
    // Clean up temp dir
    process.env.NIRI_HOME = originalHome
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
