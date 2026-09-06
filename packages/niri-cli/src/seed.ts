import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { parse as parseYaml } from "yaml"
import type { AgentConfig, Json } from "./client.js"

export type SeedAgent = { id: string; config: AgentConfig; start?: boolean }

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const config = (value: unknown, label: string): AgentConfig => object(value, label) as AgentConfig

export const decodeSeed = (value: unknown, defaultId?: string): SeedAgent[] => {
  const input = object(value, "seed")
  const entries = Array.isArray(input.agents) ? input.agents : [input]
  return entries.map((entry, index) => {
    const row = object(entry, `seed agent ${index + 1}`)
    const wrapped = row.config !== undefined
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : defaultId
    if (!id) throw new Error(`seed agent ${index + 1}.id must be a non-empty string`)
    if (row.start !== undefined && typeof row.start !== "boolean") throw new Error(`seed agent ${index + 1}.start must be true or false`)
    // Plain AgentFile documents and {id, config} seed wrappers both preserve configPolicy unchanged.
    return { id, config: config(wrapped ? row.config : row, `seed agent ${index + 1}.config`), ...(row.start === true ? { start: true } : {}) }
  })
}

const nixJson = async (file: string): Promise<unknown> => new Promise((resolve, reject) => {
  const child = spawn("nix", ["eval", "--json", "--file", file], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""; let error = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString() })
  child.once("error", reject)
  child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`nix eval failed${error.trim() ? `: ${error.trim()}` : ""}`)))
})

export async function loadDocument(file: string): Promise<unknown> {
  const extension = path.extname(file).toLowerCase()
  const text = extension === ".nix" ? await nixJson(file) : await fs.readFile(file, "utf8")
  try { return extension === ".yaml" || extension === ".yml" ? parseYaml(String(text)) : JSON.parse(String(text)) as Json }
  catch (error) { throw new Error(`cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`) }
}

export async function loadConfigDocument(file: string): Promise<AgentConfig> {
  return config(await loadDocument(file), `config ${file}`)
}

export async function loadSeed(file: string): Promise<SeedAgent[]> {
  try { return decodeSeed(await loadDocument(file), path.basename(file, path.extname(file))) }
  catch (error) { throw new Error(`cannot load seed ${file}: ${error instanceof Error ? error.message : String(error)}`) }
}
