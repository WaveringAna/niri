import { createHash } from "node:crypto"

const HASHLINE_ANCHOR_RE = /^(\d+)#([0-9a-f]{6})$/

/** Short content hash used in `<line>#<hash>` anchors. */
export function hashlineLineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, 6)
}

function resolveHashlineAnchor(lines: string[], anchor: string, label: string): number {
  const match = HASHLINE_ANCHOR_RE.exec(anchor.trim())
  if (!match) {
    throw new Error(`invalid ${label} anchor '${anchor}': expected the form <line>#<hash>, e.g. 12#a1b2c3 (re-read with hashline enabled)`)
  }
  const hintedLine = Number.parseInt(match[1]!, 10)
  const hash = match[2]!

  if (hintedLine >= 1 && hintedLine <= lines.length && hashlineLineHash(lines[hintedLine - 1]!) === hash) {
    return hintedLine
  }

  const matches: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (hashlineLineHash(lines[i]!) === hash) matches.push(i + 1)
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    throw new Error(`hashline ${label} anchor '${anchor}' not found: the file changed since it was read; re-read with hashline enabled`)
  }
  throw new Error(`hashline ${label} anchor '${anchor}' is ambiguous (matches lines ${matches.join(", ")}); re-read with hashline enabled and use a range`)
}

/**
 * Apply one hashline edit. A target is a single `<line>#<hash>` anchor or an
 * inclusive `<line>#<hash>-<line>#<hash>` range. Empty content deletes it.
 *
 * Newline semantics: a file's trailing-newline state is preserved (editing a
 * file with no EOF newline never adds one), and one terminal newline in
 * `content` is a separator, not an extra blank line.
 */
export function applyHashlineEdit(
  existing: string,
  target: string,
  content: string,
): { result: string; startLine: number; endLine: number } {
  const trimmed = target.trim()
  const dashIndex = trimmed.indexOf("-")
  const startAnchor = dashIndex === -1 ? trimmed : trimmed.slice(0, dashIndex)
  const endAnchor = dashIndex === -1 ? trimmed : trimmed.slice(dashIndex + 1)

  const hadTrailingNewline = existing.endsWith("\n")
  const lines = existing.split("\n")
  if (lines.at(-1) === "") lines.pop()

  const start = resolveHashlineAnchor(lines, startAnchor, "start")
  const end = resolveHashlineAnchor(lines, endAnchor, "end")
  if (start > end) {
    throw new Error(`hashline range is inverted after resolving anchors (start line ${start}, end line ${end})`)
  }

  let replacement: string[]
  if (content.length === 0) replacement = []
  else if (content.endsWith("\n")) replacement = content.slice(0, -1).split("\n")
  else replacement = content.split("\n")
  lines.splice(start - 1, end - start + 1, ...replacement)
  const joined = lines.join("\n")
  return { result: hadTrailingNewline ? `${joined}\n` : joined, startLine: start, endLine: end }
}

/** Prefix selected file lines with anchors compatible with applyHashlineEdit. */
export function annotateHashlines(lines: readonly string[], firstLine: number): string {
  return lines.map((line, index) => `${firstLine + index}#${hashlineLineHash(line)} ${line}`).join("\n")
}
