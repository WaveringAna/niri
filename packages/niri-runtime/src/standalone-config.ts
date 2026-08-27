import path from "node:path"
import { agentSettings, type AgentFile } from "@niri/agent-config"

/** Build the complete process environment for a standalone worker.
 * Topology fields are intentionally handled here rather than by agentSettings,
 * because managed workers also bind them outside that provider/runtime mapper.
 */
export function standaloneEnvironment(config: AgentFile, configPath: string, parent: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): NodeJS.ProcessEnv {
  const id=(config.id ?? path.basename(configPath).replace(/\.ya?ml$/i,"")).trim()
  if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${configPath}: invalid agent id ${id}`)
  const client=config.client?.trim(); if(!client) throw new Error(`${configPath}: client is required`)
  if(client !== "local") { const url=new URL(client); if(!["http:","https:"].includes(url.protocol)||url.username||url.password) throw new Error(`${configPath}: client must be local or an HTTP(S) URL without credentials`) }
  const home=path.resolve(cwd,config.home ?? path.join("data","agents",id))
  const workspace=config.workspace ? path.resolve(cwd,config.workspace) : undefined
  const port=config.port ?? Number.parseInt(parent.PORT ?? "3000",10)
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error(`${configPath}: invalid worker port ${port}`)
  return {
    ...parent,
    ...agentSettings(config),
    HOME:home,
    NIRI_HOME:home,
    NIRI_AGENT_ID:id,
    AGENT_ID:id,
    AGENT_NAME:config.name?.trim() || id,
    NIRI_CLIENT:client,
    ...(workspace ? {NIRI_CLIENT_WORKSPACE:workspace}:{}),
    PORT:String(port),
    NIRI_MANAGED_WORKER:"false",
    NIRI_MIGRATE_LEGACY_STATE:agentSettings(config).NIRI_MIGRATE_LEGACY_STATE ?? "false",
  }
}
