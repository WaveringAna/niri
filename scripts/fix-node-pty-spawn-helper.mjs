import fs from "node:fs"
import path from "node:path"
import process from "node:process"

if (process.platform === "darwin") {
  const candidates = [
    path.resolve("node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.resolve("node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ]

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue

    const currentMode = fs.statSync(file).mode
    const nextMode = currentMode | 0o755

    if (nextMode !== currentMode) {
      fs.chmodSync(file, nextMode)
      console.log(`[postinstall] fixed executable bit: ${path.relative(process.cwd(), file)}`)
    }
  }
}
