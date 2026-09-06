import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_NEW_AGENT_CONFIG,
  type AgentConfig,
  type AgentFile,
  isAllowedConfigPath,
  parseAgentConfig,
  redactAgentConfig,
} from "@niri/agent-config"

export type ConfigActor = "operator" | "seed" | `agent:${string}`
export type ApplicationState = "draft" | "pending" | "applying" | "active" | "failed"
export type ConfigErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_CONFIG"
  | "POLICY_DENIED"
  | "IMMUTABLE_FIELD"
  | "SEED_CONFLICT"

export class ConfigError extends Error {
  constructor(public readonly status: number, public readonly code: ConfigErrorCode, message: string, public readonly details?: unknown) {
    super(message)
    this.name = "ConfigError"
  }
}

export type ConfigApplication = { state: ApplicationState; error?: string; desiredRevision: number; activeRevision?: number }
export type ConfigView = {
  id: string
  enabled: boolean
  revision: number
  config: AgentConfig
  application: ConfigApplication
  createdAt: string
  updatedAt: string
}
export type ConfigRevision = {
  id: string
  revision: number
  config: AgentConfig
  actor: ConfigActor
  reason?: string
  createdAt: string
}
export type MutationMeta = { actor: ConfigActor; reason?: string; requestId?: string; idempotencyKey?: string }
export type CreateConfigInput = MutationMeta & { config: Partial<AgentConfig> & { id: string }; enabled?: boolean; /** Preserve this imported config as a future three-way seed baseline. */ seed?: boolean }
export type UpdateConfigInput = MutationMeta & { patch: unknown; expectedRevision: number }
export type SeedConfigInput = MutationMeta & { config: AgentFile; reapply?: boolean; expectedRevision?: number }
export type CandidateValidator = (candidate: AgentConfig, id: string) => void
export type ConfigStoreOptions = { validate?: CandidateValidator }

type ConfigRow = {
  id: string; config: string; desired_revision: number; active_revision: number | null; enabled: number
  application_state: ApplicationState; application_error: string | null; seed_config: string | null; enforced_values: string | null
  created_at: string; updated_at: string
}
type RevisionRow = { agent_id: string; revision: number; config: string; actor: ConfigActor; reason: string | null; created_at: string }

const now = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
const parseJson = <T>(value: string): T => JSON.parse(value) as T
const own = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const unsafe = new Set(["__proto__", "prototype", "constructor"])

function safe(value: unknown, label = "value"): void {
  if (Array.isArray(value)) return value.forEach((item, index) => safe(item, `${label}[${index}]`))
  if (!own(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (unsafe.has(key)) throw new ConfigError(400, "INVALID_CONFIG", `${label}.${key} is unsafe`)
    safe(child, `${label}.${key}`)
  }
}

/**
 * A patch may name a field by path or by block: `{"discord.dmWhitelist": id}`
 * and `{discord: {dmWhitelist: id}}` are the same edit, so the cli's path
 * vocabulary and the repl's block vocabulary both work. `secrets` keys are
 * literal dot paths, so only their first segment expands.
 */
function expandPaths(patch: unknown): unknown {
  if (!own(patch)) return patch
  let expanded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes(".")) { expanded = merge(expanded, { [key]: value }) as Record<string, unknown>; continue }
    const [head, ...rest] = key.split(".")
    const nested = head === "secrets"
      ? { secrets: { [rest.join(".")]: value } }
      : [head!, ...rest].reduceRight<unknown>((inner, part) => ({ [part!]: inner }), value)
    expanded = merge(expanded, nested) as Record<string, unknown>
  }
  return expanded
}

/** JSON merge patch: objects merge, arrays replace, and null removes a member. */
function merge(base: unknown, patch: unknown): unknown {
  if (!own(patch)) return structuredClone(patch)
  const result: Record<string, unknown> = own(base) ? structuredClone(base) as Record<string, unknown> : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = merge(result[key], value)
  }
  return result
}

const PATCH_SHAPE = 'patch config fields themselves, as blocks or paths: {"discord": {"dmWhitelist": "id"}} or {"discord.dmWhitelist": "id"}'

/** A rejected patch should teach its shape; guessing it costs an agent a whole turn. */
function patchAdvice(error: unknown, patch: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (own(patch) && Object.keys(patch).length === 1 && "config" in patch) return `${message} — the patch is the config fragment itself, so drop the outer "config" wrapper`
  return /unknown keys/.test(message) ? `${message} — ${PATCH_SHAPE}` : message
}

function replacementPatch(current: unknown, target: unknown): unknown {
  if (!own(current) || !own(target)) return structuredClone(target)
  const patch: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
    patch[key] = key in target ? replacementPatch(current[key], target[key]) : null
  }
  return patch
}

function equal(a: unknown, b: unknown): boolean { return json(a) === json(b) }
function getAt(value: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((current, key) => own(current) ? current[key] : undefined, value)
}
function setAt(value: Record<string, unknown>, dotPath: string, next: unknown): void {
  const parts = dotPath.split("."); const parents: Array<[Record<string, unknown>, string]> = []
  let cursor = value
  for (const part of parts.slice(0, -1)) { parents.push([cursor, part]); cursor = (cursor[part] = own(cursor[part]) ? cursor[part] : {}) as Record<string, unknown> }
  const leaf = parts.at(-1)!
  if (next !== undefined) { cursor[leaf] = structuredClone(next); return }
  delete cursor[leaf]
  for (const [parent, key] of parents.reverse()) {
    const child = parent[key]
    if (own(child) && Object.keys(child).length === 0) delete parent[key]
    else break
  }
}
function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (equal(before, after)) return []
  if (own(before) && !own(after)) return Object.keys(before).flatMap((key) => changedPaths(before[key], undefined, prefix ? `${prefix}.${key}` : key))
  if (!own(before) && own(after)) return Object.keys(after).flatMap((key) => changedPaths(undefined, after[key], prefix ? `${prefix}.${key}` : key))
  if (!own(before) || !own(after)) return prefix ? [prefix] : []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key))
}
function pathsOverlap(a: string, b: string): boolean { return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`) }

function enforcedValues(config: AgentConfig): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const path of config.configPolicy.enforcedPaths ?? []) {
    const value = getAt(config, path)
    if (value === undefined) throw new ConfigError(400, "INVALID_CONFIG", `enforced path ${path} has no value`)
    values[path] = value
  }
  return values
}

function policyViolation(actor: ConfigActor, before: AgentConfig, after: AgentConfig, enforced: Record<string, unknown>): ConfigError | undefined {
  const changes = changedPaths(before, after)
  if (actor.startsWith("agent:") && actor !== `agent:${before.id}`) return new ConfigError(403, "POLICY_DENIED", "agent actor does not own this config")
  for (const field of changes) {
    if (actor.startsWith("agent:")) {
      if (!isAllowedConfigPath(before.configPolicy, field)) return new ConfigError(403, "POLICY_DENIED", `agent may not edit ${field}`)
    }
    if (["id", "home", "embedding.dimensions"].some((locked) => pathsOverlap(field, locked))) {
      return new ConfigError(409, "IMMUTABLE_FIELD", `${field} requires a migration`)
    }
    for (const [enforcedPath, expected] of Object.entries(enforced)) {
      if (pathsOverlap(field, enforcedPath) && !equal(getAt(after, enforcedPath), expected)) {
        return new ConfigError(403, "POLICY_DENIED", `${enforcedPath} is enforced by the operator`)
      }
    }
  }
  return undefined
}

function view(row: ConfigRow): ConfigView {
  return {
    id: row.id, enabled: Boolean(row.enabled), revision: row.desired_revision,
    config: redactAgentConfig(parseAgentConfig(parseJson(row.config), `stored config ${row.id}`)),
    application: { state: row.application_state, ...(row.application_error ? { error: row.application_error } : {}), desiredRevision: row.desired_revision, ...(row.active_revision === null ? {} : { activeRevision: row.active_revision }) },
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class ConfigStore {
  readonly db: Database.Database
  private validator?: CandidateValidator
  constructor(dbPath: string, options: ConfigStoreOptions = {}) {
    this.validator = options.validate
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 })
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.exec(`
      create table if not exists agent_configs (
        id text primary key, config text not null, desired_revision integer not null, active_revision integer,
        enabled integer not null default 0, application_state text not null, application_error text,
        seed_config text, enforced_values text, created_at text not null, updated_at text not null
      );
      create table if not exists agent_config_revisions (
        agent_id text not null, revision integer not null, config text not null, actor text not null,
        reason text, created_at text not null, primary key(agent_id, revision)
      );
      create table if not exists agent_config_idempotency (
        agent_id text not null, key text not null, operation text not null, actor text not null default '', fingerprint text not null default '', response text not null,
        created_at text not null, primary key(agent_id, key, operation)
      );
    `)
    const columns = this.db.prepare("pragma table_info(agent_config_idempotency)").all() as Array<{ name: string }>
    if (!columns.some(({ name }) => name === "actor")) this.db.exec("alter table agent_config_idempotency add column actor text not null default ''")
    if (!columns.some(({ name }) => name === "fingerprint")) this.db.exec("alter table agent_config_idempotency add column fingerprint text not null default ''")
  }
  setValidator(validate?: CandidateValidator): void { this.validator = validate }
  private validate(candidate: AgentConfig, id: string): void {
    try { this.validator?.(candidate, id) }
    catch (error) { throw error instanceof ConfigError ? error : new ConfigError(409, "CONFLICT", error instanceof Error ? error.message : String(error)) }
  }
  close(): void { this.db.close() }
  /** Parse and run the fleet validator without persisting a candidate. */
  validateCandidate(value: unknown, id?: string): AgentConfig {
    const candidate = parseAgentConfig(value, id ? `agent ${id}` : "agent candidate")
    const candidateId = id ?? candidate.id
    if (!candidateId) throw new ConfigError(400, "INVALID_CONFIG", "config.id is required")
    this.validate(candidate, candidateId)
    return candidate
  }
  private row(id: string): ConfigRow | undefined { return this.db.prepare("select * from agent_configs where id = ?").get(id) as ConfigRow | undefined }
  private fingerprint(input: unknown): string {
    const value = structuredClone(input) as Record<string, unknown>
    delete value.idempotencyKey; delete value.requestId
    return json(value)
  }
  private idempotent(id: string, operation: string, meta: MutationMeta, input: unknown): ConfigView | undefined {
    const key = meta.idempotencyKey ?? meta.requestId
    if (!key) return undefined
    const row = this.db.prepare("select response,actor,fingerprint from agent_config_idempotency where agent_id=? and key=? and operation=?").get(id, key, operation) as { response: string; actor: string; fingerprint: string } | undefined
    if (!row) return undefined
    if (row.actor !== meta.actor || row.fingerprint !== this.fingerprint(input)) throw new ConfigError(409, "IDEMPOTENCY_CONFLICT", "request id was already used for another mutation")
    return parseJson<ConfigView>(row.response)
  }
  private remember(id: string, operation: string, meta: MutationMeta, input: unknown, result: ConfigView): void {
    const key = meta.idempotencyKey ?? meta.requestId
    if (key) this.db.prepare("insert into agent_config_idempotency(agent_id,key,operation,actor,fingerprint,response,created_at) values(?,?,?,?,?,?,?)").run(id, key, operation, meta.actor, this.fingerprint(input), json(result), now())
  }
  private revision(id: string, revision: number, config: AgentConfig, meta: MutationMeta): void {
    this.db.prepare("insert into agent_config_revisions(agent_id,revision,config,actor,reason,created_at) values(?,?,?,?,?,?)").run(id, revision, json(config), meta.actor, meta.reason ?? null, now())
  }
  list(): ConfigView[] { return (this.db.prepare("select * from agent_configs order by id").all() as ConfigRow[]).map(view) }
  get(id: string): ConfigView | null { const row = this.row(id); return row ? view(row) : null }
  /** Deliberately internal-only: callers that need worker settings resolve secrets at startup. */
  getRaw(id: string): AgentConfig | null { const row = this.row(id); return row ? parseAgentConfig(parseJson(row.config), `stored config ${id}`) : null }
  create(input: CreateConfigInput): ConfigView { return this.db.transaction(() => this.createNow(input))() }
  private createNow(input: CreateConfigInput): ConfigView {
    safe(input.config)
    const id = input.config.id?.trim()
    if (!id) throw new ConfigError(400, "INVALID_CONFIG", "config.id is required")
    const replay = this.idempotent(id, "create", input, input); if (replay) return replay
    if (this.row(id)) throw new ConfigError(409, "ALREADY_EXISTS", `agent ${id} already exists`)
    let config: AgentConfig
    try { config = parseAgentConfig(input.seed ? input.config : merge(DEFAULT_NEW_AGENT_CONFIG, input.config), `agent ${id}`) }
    catch (error) { throw new ConfigError(400, "INVALID_CONFIG", error instanceof Error ? error.message : String(error)) }
    this.validate(config, id)
    const created = now()
    this.db.prepare("insert into agent_configs values(?,?,?,?,?,?,?,?,?,?,?)").run(id, json(config), 1, null, input.enabled ? 1 : 0, input.enabled ? "pending" : "draft", null, input.seed ? json(config) : null, json(enforcedValues(config)), created, created)
    this.revision(id, 1, config, input)
    const result = this.get(id)!; this.remember(id, "create", input, input, result); return result
  }
  update(id: string, input: UpdateConfigInput): ConfigView { return this.db.transaction(() => this.updateNow(id, input))() }
  private updateNow(id: string, input: UpdateConfigInput, operation = "update", fingerprint: unknown = input): ConfigView {
    safe(input.patch)
    const replay = this.idempotent(id, operation, input, fingerprint); if (replay) return replay
    const row = this.row(id); if (!row) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
    if (row.desired_revision !== input.expectedRevision) throw new ConfigError(409, "CONFLICT", "config revision does not match", { expectedRevision: input.expectedRevision, actualRevision: row.desired_revision })
    const before = parseAgentConfig(parseJson(row.config), `stored config ${id}`)
    const patch = expandPaths(input.patch)
    let after: AgentConfig
    try { after = parseAgentConfig(merge(before, patch), `agent ${id} patch`) }
    catch (error) { throw new ConfigError(400, "INVALID_CONFIG", patchAdvice(error, patch)) }
    this.validate(after, id)
    const violation = policyViolation(input.actor, before, after, row.enforced_values ? parseJson(row.enforced_values) : {})
    if (violation) throw violation
    const revision = row.desired_revision + 1; const updated = now()
    this.db.prepare("update agent_configs set config=?,desired_revision=?,application_state='pending',application_error=null,updated_at=? where id=?").run(json(after), revision, updated, id)
    this.revision(id, revision, after, input)
    const result = this.get(id)!; this.remember(id, operation, input, fingerprint, result); return result
  }
  history(id: string): ConfigRevision[] {
    if (!this.row(id)) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
    return (this.db.prepare("select * from agent_config_revisions where agent_id=? order by revision desc").all(id) as RevisionRow[]).map((row) => ({ id: row.agent_id, revision: row.revision, config: redactAgentConfig(parseAgentConfig(parseJson(row.config), `revision ${row.revision}`)), actor: row.actor, ...(row.reason ? { reason: row.reason } : {}), createdAt: row.created_at }))
  }
  rollback(id: string, revision: number, input: Omit<MutationMeta, "actor"> & { actor?: ConfigActor; expectedRevision: number }): ConfigView {
    return this.db.transaction(() => {
      const actor = input.actor ?? "operator"; const fingerprint = { revision, expectedRevision: input.expectedRevision, reason: input.reason }
      const replay = this.idempotent(id, "rollback", { ...input, actor }, fingerprint); if (replay) return replay
      const row = this.db.prepare("select * from agent_config_revisions where agent_id=? and revision=?").get(id, revision) as RevisionRow | undefined
      if (!row) throw new ConfigError(404, "NOT_FOUND", `revision ${revision} not found`)
      const current = this.getRaw(id)
      if (!current) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
      return this.updateNow(id, { ...input, actor, patch: replacementPatch(current, parseJson(row.config)), expectedRevision: input.expectedRevision }, "rollback", fingerprint)
    })()
  }
  setEnabled(id: string, enabled: boolean, meta: MutationMeta = { actor: "operator" }): ConfigView { return this.db.transaction(() => this.setEnabledNow(id, enabled, meta))() }
  private setEnabledNow(id: string, enabled: boolean, meta: MutationMeta): ConfigView {
    const replay = this.idempotent(id, "enabled", meta, { enabled }); if (replay) return replay
    const row = this.row(id); if (!row) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
    this.db.prepare("update agent_configs set enabled=?,application_state=?,updated_at=? where id=?").run(enabled ? 1 : 0, enabled ? "pending" : "draft", now(), id)
    const result = this.get(id)!; this.remember(id, "enabled", meta, { enabled }, result); return result
  }
  private lifecycle(id: string, state: ApplicationState, error?: string, revision?: number): ConfigView {
    const row = this.row(id); if (!row) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
    if (revision !== undefined && revision !== row.desired_revision) throw new ConfigError(409, "CONFLICT", "config revision does not match", { expectedRevision: revision, actualRevision: row.desired_revision })
    this.db.prepare("update agent_configs set application_state=?,application_error=?,active_revision=?,updated_at=? where id=?").run(state, error ?? null, state === "active" ? row.desired_revision : row.active_revision, now(), id)
    return this.get(id)!
  }
  markApplying(id: string, revision?: number): ConfigView { return this.lifecycle(id, "applying", undefined, revision) }
  markActive(id: string, revision?: number): ConfigView { return this.lifecycle(id, "active", undefined, revision) }
  markFailed(id: string, error: string, revision?: number): ConfigView { return this.lifecycle(id, "failed", error, revision) }
  previewSeed(input: SeedConfigInput): { config: AgentConfig; diff: string[]; conflicts: string[] } {
    safe(input.config)
    const id = input.config.id?.trim(); if (!id) throw new ConfigError(400, "INVALID_CONFIG", "seed config.id is required")
    const incoming = parseAgentConfig(input.config, `seed ${id}`)
    const current = this.row(id)
    if (!current) { this.validate(incoming, id); return { config: redactAgentConfig(incoming), diff: changedPaths({}, incoming), conflicts: [] } }
    if (!input.reapply) return { config: redactAgentConfig(parseAgentConfig(parseJson(current.config), `stored config ${id}`)), diff: [], conflicts: [] }
    if (input.expectedRevision === undefined || input.expectedRevision !== current.desired_revision) throw new ConfigError(409, "CONFLICT", "config revision does not match", { expectedRevision: input.expectedRevision, actualRevision: current.desired_revision })
    const base = current.seed_config ? parseJson<AgentConfig>(current.seed_config) : parseAgentConfig(parseJson(current.config), `stored config ${id}`)
    const desired = parseAgentConfig(parseJson(current.config), `stored config ${id}`)
    const next = structuredClone(desired) as unknown as Record<string, unknown>
    const enforced = new Set(incoming.configPolicy.enforcedPaths ?? [])
    const conflicts: string[] = []
    for (const field of changedPaths(base, incoming)) {
      const proposed = getAt(incoming, field)
      const existing = getAt(desired, field); const previous = getAt(base, field)
      if (!equal(existing, previous) && !equal(existing, proposed) && ![...enforced].some((path) => pathsOverlap(path, field))) conflicts.push(field)
      else setAt(next, field, proposed)
    }
    for (const path of incoming.configPolicy.enforcedPaths ?? []) setAt(next, path, getAt(incoming, path))
    const candidate = parseAgentConfig(next, `seed ${id}`)
    const immutable = policyViolation("operator", desired, candidate, {})
    if (immutable) throw immutable
    if (!conflicts.length) this.validate(candidate, id)
    return { config: redactAgentConfig(candidate), diff: changedPaths(desired, candidate), conflicts }
  }

  seed(input: SeedConfigInput): ConfigView { return this.db.transaction(() => this.seedNow(input))() }
  private seedNow(input: SeedConfigInput): ConfigView {
    safe(input.config)
    const id = input.config.id?.trim(); if (!id) throw new ConfigError(400, "INVALID_CONFIG", "seed config.id is required")
    const replay = this.idempotent(id, "seed", input, input); if (replay) return replay
    const current = this.row(id)
    const incoming = parseAgentConfig(input.config, `seed ${id}`)
    const enforced = enforcedValues(incoming)
    if (!current) {
      this.validate(incoming, id)
      const created = now()
      this.db.prepare("insert into agent_configs values(?,?,?,?,?,?,?,?,?,?,?)").run(id, json(incoming), 1, null, 1, "pending", null, json(incoming), json(enforced), created, created)
      this.revision(id, 1, incoming, input)
      const result = this.get(id)!; this.remember(id, "seed", input, input, result); return result
    }
    if (!input.reapply) return this.get(id)!
    if (input.expectedRevision === undefined) throw new ConfigError(409, "CONFLICT", "seed reapply requires expectedRevision")
    if (input.expectedRevision !== current.desired_revision) throw new ConfigError(409, "CONFLICT", "config revision does not match", { expectedRevision: input.expectedRevision, actualRevision: current.desired_revision })
    const base = current.seed_config ? parseJson<AgentConfig>(current.seed_config) : parseAgentConfig(parseJson(current.config), `stored config ${id}`)
    const desired = parseAgentConfig(parseJson(current.config), `stored config ${id}`)
    const next = structuredClone(desired) as unknown as Record<string, unknown>
    const conflicts: string[] = []
    for (const field of changedPaths(base, incoming)) {
      const incomingValue = getAt(incoming, field); const existing = getAt(desired, field); const previous = getAt(base, field)
      if (!equal(existing, previous) && !equal(existing, incomingValue) && !Object.keys(enforced).some((path) => pathsOverlap(path, field))) conflicts.push(field)
      else setAt(next, field, incomingValue)
    }
    // A newly selected enforced path wins even where its seed value itself did not change.
    for (const path of incoming.configPolicy.enforcedPaths ?? []) setAt(next, path, getAt(incoming, path))
    if (conflicts.length) throw new ConfigError(409, "SEED_CONFLICT", "seed conflicts with local edits", { paths: conflicts })
    let config: AgentConfig
    try { config = parseAgentConfig(next, `seed ${id}`) } catch (error) { throw new ConfigError(400, "INVALID_CONFIG", error instanceof Error ? error.message : String(error)) }
    const immutable = policyViolation("operator", desired, config, {})
    if (immutable) throw immutable
    this.validate(config, id)
    const persistedEnforced = enforcedValues(config)
    const revision = current.desired_revision + 1
    this.db.prepare("update agent_configs set config=?,desired_revision=?,application_state='pending',application_error=null,seed_config=?,enforced_values=?,updated_at=? where id=?").run(json(config), revision, json(incoming), json(persistedEnforced), now(), id)
    this.revision(id, revision, config, input)
    const result = this.get(id)!; this.remember(id, "seed", input, input, result); return result
  }
}
