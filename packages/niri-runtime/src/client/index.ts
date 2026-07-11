import { AGENT_ID } from "../agent-config"
import { ClientToolBroker } from "@mira/harness-server"

export const clientToolBroker = new ClientToolBroker({
  agentId: AGENT_ID,
  token: process.env.NIRI_TOOL_CLIENT_TOKEN,
  expectedClientId: process.env.NIRI_EXPECTED_CLIENT_ID,
})

export { ClientToolBroker } from "@mira/harness-server"
export type { ClientBrokerStatus, ClientBrokerOptions } from "@mira/harness-server"
