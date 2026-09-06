import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Local operator credential, never forwarded to the tool host or an agent. */
export function getOrCreateToken(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  fs.chmodSync(file, 0o600)
  const token = fs.readFileSync(file, "utf8").trim()
  if (token.length < 32) throw new Error(`invalid control credential file: ${file}`)
  return token
}

export function deriveAgentToken(adminToken: string, id: string): string {
  return createHmac("sha256", adminToken).update(`niri:agent-config:v1:${id}`).digest("base64url")
}

export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ") || !expected) return false
  const actual = Buffer.from(authorization.slice(7))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
