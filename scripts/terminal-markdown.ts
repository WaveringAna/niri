const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bYellow: "\x1b[93m",
  bBlue: "\x1b[94m",
  bMagenta: "\x1b[95m",
  bCyan: "\x1b[96m",
}

const KW_JS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
  "function", "class", "const", "let", "var", "new", "delete", "typeof", "instanceof",
  "import", "export", "default", "from", "async", "await", "try", "catch", "finally",
  "throw", "null", "undefined", "true", "false", "void", "in", "of", "this", "super",
  "extends", "implements", "interface", "type", "enum", "namespace", "declare", "abstract",
  "public", "private", "protected", "static", "readonly", "override", "satisfies", "as",
  "keyof", "infer", "never", "unknown", "any",
])

const KW_PY = new Set([
  "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from",
  "as", "def", "class", "return", "yield", "pass", "break", "continue", "try", "except",
  "finally", "raise", "with", "lambda", "True", "False", "None", "global", "nonlocal",
  "del", "assert", "async", "await", "self", "super",
])

const KW_RUST = new Set([
  "fn", "let", "mut", "const", "static", "pub", "use", "mod", "crate", "super", "self",
  "struct", "enum", "impl", "trait", "type", "where", "for", "while", "if", "else", "match",
  "return", "break", "continue", "loop", "move", "ref", "in", "as", "unsafe", "dyn",
  "async", "await", "true", "false", "Some", "None", "Ok", "Err",
])

const KW_BASH = new Set([
  "if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until", "case", "in",
  "esac", "function", "return", "local", "export", "echo", "exit", "source", "set", "unset",
])

const getKeywords = (lang: string): Set<string> => {
  switch (lang) {
    case "python":
    case "py":
      return KW_PY
    case "rust":
    case "rs":
      return KW_RUST
    case "bash":
    case "sh":
    case "shell":
    case "zsh":
    case "fish":
      return KW_BASH
    default:
      return KW_JS
  }
}

const highlightCode = (code: string, lang: string): string => {
  const l = lang.toLowerCase()
  const keywords = getKeywords(l)
  const isPython = l === "python" || l === "py"
  const isBash = ["bash", "sh", "shell", "zsh", "fish"].includes(l)
  const isPlain = l === "" || l === "text" || l === "txt" || l === "plain"

  if (isPlain) return code

  let result = ""
  let i = 0

  while (i < code.length) {
    const ch = code[i]!

    if (!isPython && !isBash && ch === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i)
      const comment = end === -1 ? code.slice(i) : code.slice(i, end)
      result += c.gray + c.italic + comment + c.reset
      i += comment.length
      continue
    }

    if (!isPython && !isBash && ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2)
      const comment = end === -1 ? code.slice(i) : code.slice(i, end + 2)
      result += c.gray + c.italic + comment + c.reset
      i += comment.length
      continue
    }

    if ((isPython || isBash) && ch === "#") {
      const end = code.indexOf("\n", i)
      const comment = end === -1 ? code.slice(i) : code.slice(i, end)
      result += c.gray + c.italic + comment + c.reset
      i += comment.length
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2
          continue
        }
        if (code[j] === ch) {
          j++
          break
        }
        j++
      }
      result += c.green + code.slice(i, j) + c.reset
      i = j
      continue
    }

    if (/[0-9]/.test(ch) && (i === 0 || /\W/.test(code[i - 1]!))) {
      let j = i
      while (j < code.length && /[0-9._xXa-fA-FobBnNlLeE+\-]/.test(code[j]!)) j++
      result += c.bYellow + code.slice(i, j) + c.reset
      i = j
      continue
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j]!)) j++
      const word = code.slice(i, j)

      if (keywords.has(word)) {
        result += c.bMagenta + word + c.reset
      } else if (/^[A-Z]/.test(word)) {
        result += c.bYellow + word + c.reset
      } else if (code[j] === "(") {
        result += c.bBlue + word + c.reset
      } else {
        result += word
      }
      i = j
      continue
    }

    result += ch
    i++
  }

  return result
}

const renderInline = (text: string): string =>
  text
    .replace(/\*\*\*(.*?)\*\*\*/g, `${c.bold}${c.italic}$1${c.reset}`)
    .replace(/\*\*(.*?)\*\*/g, `${c.bold}$1${c.reset}`)
    .replace(/\*(.*?)\*/g, `${c.italic}$1${c.reset}`)
    .replace(/~~(.*?)~~/g, `${c.dim}$1${c.reset}`)
    .replace(/`([^`]+)`/g, `${c.cyan}$1${c.reset}`)

export const renderMarkdownAnsi = (text: string): string => {
  const lines = text.split("\n")
  const out: string[] = []
  const width = Math.min(process.stdout.columns || 80, 120)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!)
        i++
      }
      i++

      const code = codeLines.join("\n")
      const highlighted = highlightCode(code, lang)

      if (lang) out.push(`${c.dim}${c.cyan}┌─ ${lang}${c.reset}`)
      for (const highlightedLine of highlighted.split("\n")) {
        out.push(`${c.dim}│${c.reset} ${highlightedLine}`)
      }
      out.push(`${c.dim}└${c.reset}`)
      continue
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (hMatch) {
      const level = hMatch[1]!.length
      const title = renderInline(hMatch[2]!)
      const colors = [c.bCyan, c.cyan, c.bBlue, c.bBlue, c.bMagenta, c.bMagenta]
      const color = colors[Math.min(level - 1, colors.length - 1)]!
      out.push(c.bold + color + title + c.reset)
      i++
      continue
    }

    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      out.push(c.dim + "─".repeat(width) + c.reset)
      i++
      continue
    }

    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/)
    if (ulMatch) {
      const indent = ulMatch[1]!
      out.push(`${indent}${c.dim}•${c.reset} ${renderInline(ulMatch[2]!)}`)
      i++
      continue
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/)
    if (olMatch) {
      const indent = olMatch[1]!
      out.push(`${indent}${c.dim}${olMatch[2]}.${c.reset} ${renderInline(olMatch[3]!)}`)
      i++
      continue
    }

    if (line.startsWith("> ")) {
      out.push(`${c.dim}│${c.reset} ${c.italic}${renderInline(line.slice(2))}${c.reset}`)
      i++
      continue
    }

    out.push(renderInline(line))
    i++
  }

  return out.join("\n")
}
