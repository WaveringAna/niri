import { startControlPlane } from "./boot"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const controlPort = Number.parseInt(argument("--port") ?? "3000", 10)
const controlHost = argument("--host") ?? "127.0.0.1"
const agentDirectory = argument("--agents")

async function main(): Promise<void> {
  const plane = await startControlPlane({
    port: controlPort,
    host: controlHost,
    ...(agentDirectory ? { agentsDirectory: agentDirectory } : {}),
  })
  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    await plane.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => { console.error("[server] fatal:", error); process.exit(1) })
