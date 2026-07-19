import { parseArgs } from "node:util"
import { parseAgentFile, agentSettings } from "@niri/agent-config"
import path from "node:path"

/**
 * Standalone remote-worker entry: parse an agent yaml file (the same parser
 * the control plane uses), flatten it into the runtime environment variables
 * that `src/index.ts` reads, mark the worker as unmanaged (so it does not
 * expect the server to supervise it), then defer to `./index.js`.
 *
 * Run as `tsx src/standalone.ts --config /path/to/agent.yaml`. The yaml must
 * set `client` and may include a `server.iroh` block so the worker dials the
 * control plane.
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
    },
  })
  const configPath = values.config
  if (!configPath) {
    throw new Error("standalone worker requires --config <path-to-agent.yaml>")
  }
  const resolved = path.resolve(configPath)
  const config = parseAgentFile(resolved)
  const client = config.client?.trim()
  if (!client) throw new Error(`${resolved}: client is required`)
  if (client !== "local") {
    const url = new URL(client)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${resolved}: client must be local or an HTTP(S) URL without credentials`)
    }
  }

  // Flatten the yaml into runtime env keys (same mapping as the server).
  const settings = agentSettings(config)
  for (const [key, value] of Object.entries(settings)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  // Standalone workers are not spawned/tracked by the control plane's supervisor.
  if (process.env.NIRI_MANAGED_WORKER === undefined) process.env.NIRI_MANAGED_WORKER = "false"

  // Default identity falls out of the yaml id (or filename) when NIRI_AGENT_ID
  // is not already set in the parent env.
  if (!process.env.NIRI_AGENT_ID) {
    const id = config.id ?? path.basename(resolved).replace(/\.ya?ml$/i, "")
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${resolved}: invalid agent id ${id}`)
    process.env.NIRI_AGENT_ID = id
    process.env.AGENT_ID = id
  }
  if (!process.env.AGENT_NAME && config.name) process.env.AGENT_NAME = config.name

  // Dynamic import: env hydration above MUST complete before index.js is
  // evaluated, which rules out a static import.
  await import("./index.js")
}

void main().catch((err) => {
  console.error("[standalone] fatal:", err)
  process.exit(1)
})
