import { parseArgs } from "node:util"
import { parseAgentFile } from "@niri/agent-config"
import path from "node:path"
import { standaloneEnvironment } from "./standalone-config"

/** Start one unsupervised worker from the same YAML shape as managed agents. */
export async function main(): Promise<void> {
  const {values}=parseArgs({options:{config:{type:"string"}}})
  if(!values.config) throw new Error("standalone worker requires --config <path-to-agent.yaml>")
  const resolved=path.resolve(values.config)
  const env=standaloneEnvironment(parseAgentFile(resolved),resolved)
  for(const [key,value] of Object.entries(env)) process.env[key]=value
  // Runtime modules read topology at import time, so hydration must finish first.
  await import("./index.js")
}
void main().catch((err)=>{console.error("[standalone] fatal:",err);process.exit(1)})
