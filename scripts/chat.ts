import path from "node:path"
import { fileURLToPath } from "node:url"

const HOST = process.env.NIRI_HOST ?? "http://localhost"
const directWorker = process.env.NIRI_CHAT_DIRECT_WORKER?.trim().toLowerCase() === "true"
const controlAgentId = directWorker ? undefined : (process.env.NIRI_AGENT_ID ?? "niri").trim() || "niri"
const PORT = directWorker ? process.env.PORT ?? "3000" : process.env.CONTROL_PORT ?? process.env.PORT ?? "3000"
const defaultBaseUrl = process.env.NIRI_SERVER_URL?.replace(/\/+$/, "") || `${HOST}:${PORT}`

export type ChatOptions = { baseUrl?: string; agentId?: string }

/**
 * Development entry point for the chat screen. The screen itself lives in the
 * cli package, where one Ink app owns the terminal; this script only resolves
 * the environment defaults and mounts it standalone.
 */
export async function runChat(options: ChatOptions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("niri chat needs a terminal; run it from an interactive shell")
  const agentId = options.agentId ?? controlAgentId
  const [{ render }, { createElement }, { ChatScreen }] = await Promise.all([
    import("ink"),
    import("react"),
    import("../packages/niri-cli/src/ui/chat.js"),
  ])
  let leave = (): void => {}
  const app = render(
    createElement(ChatScreen, {
      baseUrl: options.baseUrl ?? defaultBaseUrl,
      ...(agentId ? { agentId } : {}),
      onBack: () => leave(),
      onQuit: () => leave(),
    }),
    { stdin: process.stdin, stdout: process.stdout },
  )
  leave = app.unmount
  await app.waitUntilExit()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv[2] ?? controlAgentId
  void runChat({ ...(requested ? { agentId: requested } : {}) })
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
