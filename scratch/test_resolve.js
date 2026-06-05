import * as path from "path"
import * as fs from "fs"
import { execSync } from "child_process"

function resolveExecutable(name) {
  // 1. Try finding it with which/where command
  try {
    const stdout = execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (stdout) {
      const lines = stdout.split(/\r?\n/)
      const resolved = lines[0].trim()
      if (resolved && fs.existsSync(resolved)) {
        return resolved
      }
    }
  } catch (e) {
    // Ignore
  }

  // 2. Search standard directories manually
  const paths = (process.env.PATH || "")
    .split(path.delimiter)
    .concat([
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/sbin",
      "/sbin",
    ])
  
  for (const dir of paths) {
    if (!dir) continue
    const fullPath = path.join(dir, name)
    if (fs.existsSync(fullPath)) {
      return fullPath
    }
  }

  return name
}

console.log("docker resolved:", resolveExecutable("docker"))
console.log("bash resolved:", resolveExecutable("bash"))
