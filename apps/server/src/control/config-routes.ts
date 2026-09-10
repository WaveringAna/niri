import type { FastifyInstance, FastifyRequest } from "fastify"
import { parseAgentConfig, type AgentFile } from "@niri/agent-config"
import { ConfigError, type ConfigActor, type ConfigStore } from "./config-store"
import { tokenMatches } from "./config-auth"

export interface ConfigurationManager {
  list(): unknown[]
  start(id: string): Promise<unknown>
  stop(id: string): Promise<unknown>
  restart(id: string): Promise<unknown>
  refresh(id: string): void
  schedule(id: string): void
  validate(config: AgentFile, id?: string): void
}
export type ConfigurationControl = {
  store: ConfigStore
  manager: ConfigurationManager
  adminToken: string
  agentToken: (id: string) => string
}

export function requireOperator(control: ConfigurationControl, request: FastifyRequest): void {
  if (!tokenMatches(request.headers.authorization, control.adminToken)) {
    throw new ConfigError(403, "POLICY_DENIED", "operator credential required")
  }
}
function actor(control: ConfigurationControl, request: FastifyRequest, id: string): ConfigActor {
  if (tokenMatches(request.headers.authorization, control.adminToken)) return "operator"
  if (tokenMatches(request.headers.authorization, control.agentToken(id))) return `agent:${id}`
  throw new ConfigError(403, "POLICY_DENIED", "config credential required")
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(400, "INVALID_CONFIG", "request body must be an object")
  return value as Record<string, unknown>
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(400, "INVALID_CONFIG", "expectedRevision must be a positive integer")
  }
  return value
}
function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new ConfigError(400, "INVALID_CONFIG", `${label} must be a non-empty string of at most 2000 characters`)
  return value.trim()
}
function requiredText(value: unknown, label: string): string {
  const result = optionalText(value, label)
  if (!result) throw new ConfigError(400, "INVALID_CONFIG", `${label} is required`)
  return result
}
function optionalPrefix(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > 128) throw new ConfigError(400, "INVALID_CONFIG", "signaturePrefix must be a string of at most 128 characters")
  return value
}
function metadata(body: Record<string, unknown>, actor: ConfigActor) {
  return { actor, reason: optionalText(body.reason, "reason"), idempotencyKey: optionalText(body.requestId, "requestId") }
}

/** All adapters share the store's validation, policy, CAS, and audit transaction. */
export async function registerConfigurationRoutes(app: FastifyInstance, control: ConfigurationControl): Promise<void> {
  const { store, manager } = control
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConfigError) return reply.code(error.status).send({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) })
    const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500
    return reply.code(status).send({ error: status < 500 && error instanceof Error ? error.message : "configuration operation failed", code: "OPERATION_FAILED" })
  })
  const get = (id: string) => {
    const config = store.get(id)
    if (!config) throw new ConfigError(404, "NOT_FOUND", `agent ${id} not found`)
    return config
  }
  const agentId = (request: FastifyRequest) => (request.params as { id: string }).id

  app.post("/agents", async (request, reply) => {
    requireOperator(control, request)
    const body = object(request.body)
    if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.id)) throw new ConfigError(400, "INVALID_CONFIG", "id must match [a-zA-Z0-9_-]+")
    if (body.start !== undefined && typeof body.start !== "boolean") throw new ConfigError(400, "INVALID_CONFIG", "start must be boolean")
    if (body.seed !== undefined && typeof body.seed !== "boolean") throw new ConfigError(400, "INVALID_CONFIG", "seed must be boolean")
    const config = body.config === undefined ? {} : object(body.config)
    if (config.id !== undefined && config.id !== body.id) throw new ConfigError(400, "INVALID_CONFIG", "config.id must match id")
    const created = store.create({ config: { ...config, id: body.id }, enabled: body.start === true, seed: body.seed === true, ...metadata(body, "operator") })
    manager.schedule(created.id)
    return reply.code(201).send(created)
  })
  for (const suffix of ["", "/status"]) {
    app.get(`/agents/:id/config${suffix}`, async (request) => {
      const id = agentId(request)
      actor(control, request, id)
      return get(id)
    })
  }
  app.get("/agents/:id/config/history", async (request) => {
    const id = agentId(request)
    actor(control, request, id)
    return { history: store.history(id) }
  })
  app.patch("/agents/:id/config", async (request) => {
    const id = agentId(request)
    const who = actor(control, request, id)
    const body = object(request.body)
    object(body.patch)
    const result = store.update(id, { patch: body.patch, expectedRevision: revision(body.expectedRevision), ...metadata(body, who) })
    manager.schedule(id)
    return result
  })
  app.post("/agents/:id/config/webhooks", async (request, reply) => {
    const id = agentId(request)
    const who = actor(control, request, id)
    const body = object(request.body)
    const unknown = Object.keys(body).filter((key) => !["name", "expectedRevision", "signatureHeader", "signaturePrefix", "reason", "requestId"].includes(key))
    if (unknown.length) throw new ConfigError(400, "INVALID_CONFIG", `unknown webhook fields: ${unknown.join(", ")}`)
    const requestId = requiredText(body.requestId, "requestId")
    const provisioned = store.provisionWebhook(id, {
      actor: who,
      name: requiredText(body.name, "name"),
      expectedRevision: revision(body.expectedRevision),
      ...(body.signatureHeader !== undefined ? { signatureHeader: requiredText(body.signatureHeader, "signatureHeader") } : {}),
      ...(body.signaturePrefix !== undefined ? { signaturePrefix: optionalPrefix(body.signaturePrefix)! } : {}),
      ...(body.reason !== undefined ? { reason: requiredText(body.reason, "reason") } : {}),
      idempotencyKey: requestId,
    })
    manager.refresh(id)
    manager.schedule(id)
    return reply.code(201).send({
      ...provisioned,
      agentId: id,
      path: `/agents/${encodeURIComponent(id)}/trigger/webhook/${encodeURIComponent(provisioned.name)}`,
      requestId,
    })
  })

  app.post("/agents/:id/config/rollback", async (request) => {
    requireOperator(control, request)
    const id = agentId(request)
    const body = object(request.body)
    const target = revision(body.revision)
    const result = store.rollback(id, target, { expectedRevision: revision(body.expectedRevision), ...metadata(body, "operator") })
    manager.schedule(id)
    return result
  })
  for (const operation of ["diff", "seed"] as const) {
    app.post(`/agents/:id/config/${operation}`, async (request) => {
      requireOperator(control, request)
      const id = agentId(request)
      const body = object(request.body)
      const raw = object(body.config)
      if (raw.id !== undefined && raw.id !== id) throw new ConfigError(400, "INVALID_CONFIG", "seed id must match route id")
      let config
      try { config = parseAgentConfig({ ...raw, id }, `seed ${id}`) }
      catch (error) { throw new ConfigError(400, "INVALID_CONFIG", error instanceof Error ? error.message : "invalid seed") }
      const input = { config, expectedRevision: revision(body.expectedRevision), reapply: true, ...metadata(body, "operator") }
      if (operation === "diff") return store.previewSeed(input)
      const result = store.seed(input)
      manager.schedule(id)
      return result
    })
  }
  for (const operation of ["start", "stop", "restart"] as const) {
    app.post(`/agents/:id/${operation}`, async (request, reply) => {
      requireOperator(control, request)
      const id = agentId(request)
      get(id)
      return reply.code(202).send(await manager[operation](id))
    })
  }
}
