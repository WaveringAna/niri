import { useState } from "react"
import { useApp } from "ink"
import { AgentsView } from "./agents-view.js"
import { ChatScreen } from "./chat.js"
import { CreateFlow } from "./create.js"
import type { NiriClient } from "../client.js"

export type RootAppProps = { client: NiriClient; fetchImpl?: typeof fetch }

/** Which screen owns the terminal right now. */
type Screen = { name: "view" } | { name: "chat"; id: string; label: string } | { name: "create" }

/**
 * The whole interactive `niri` session: one Ink app, one owner of stdin, and
 * screens that replace each other. Leaving a screen unmounts it, so returning
 * to the list always remounts it and reloads.
 */
export function RootApp({ client, fetchImpl }: RootAppProps) {
  const { exit } = useApp()
  const [screen, setScreen] = useState<Screen>({ name: "view" })
  const list = (): void => setScreen({ name: "view" })

  if (screen.name === "chat") {
    return (
      <ChatScreen
        baseUrl={client.baseUrl}
        {...(client.token ? { token: client.token } : {})}
        agentId={screen.id}
        agentName={screen.label}
        {...(fetchImpl ? { fetchImpl } : {})}
        onBack={list}
        onQuit={exit}
      />
    )
  }
  if (screen.name === "create") return <CreateFlow client={client} onDone={list} />
  return <AgentsView client={client} onChat={(id, label) => setScreen({ name: "chat", id, label })} onCreate={() => setScreen({ name: "create" })} onQuit={exit} />
}
