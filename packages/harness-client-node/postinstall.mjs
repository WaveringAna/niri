import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url)
  let directory = path.dirname(require.resolve("node-pty"))
  while (path.dirname(directory) !== directory) {
    const manifest = path.join(directory, "package.json")
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "node-pty") break
    directory = path.dirname(directory)
  }
  for (const file of [
    path.join(directory, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.join(directory, "build", "Release", "spawn-helper"),
  ]) {
    if (!fs.existsSync(file)) continue
    fs.chmodSync(file, fs.statSync(file).mode | 0o755)
  }
}
