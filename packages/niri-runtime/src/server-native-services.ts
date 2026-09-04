import { readMemory, readSoul, writeMemory, writeSoul, listMemory, grepMemory } from "./agent-state-tools"
import { cancelSchedule, createSchedule, listSchedules, type Schedule } from "./scheduler"
import { listDiscordBackread, listDiscordChannels, listDiscordInbox } from "./discord/state"
import { searchDiscordMessages } from "./discord/search"
import { listAliases, removeAlias, searchMemories, setAlias } from "./memory"
import { contextArchive } from "./runner/archive"
import type { ContextSearchResult } from "@mira/agent-context"
import { readLoopBudget, type LoopBudget } from "./runner/loop-budget"
import { WorkLedgerError, createWorkItem, getWorkItem, listWorkItems, updateWorkItem, closeWorkItem, type WorkItem, type WorkItemSummary } from "./work-ledger"
import type { HostRpcMethod } from "@mira/harness-protocol"

/**
 * Server-native operations: one typed implementation per RPC-exposed method,
 * owning that method's argument validation, coercion, and result shape.
 *
 * Both callers go through here — the model tool adapters in
 * `runner/loop-tool-registry.ts` and the Python host RPC in `host-rpc.ts` — so
 * a method cannot mean one thing to the model and another to model-generated
 * Python. Add an operation here (and to `HOST_RPC_METHODS`) rather than calling
 * an underlying service function from either caller directly.
 */


export type ServiceErrorCode = "invalid_argument" | "not_found"

export class ServiceError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string) {
    super(message)
    this.name = "ServiceError"
    this.code = code
  }
}

export type ServiceArgs = Record<string, unknown>

function text(value: unknown, name: string): string {
  const out = String(value ?? "").trim()
  if (!out) throw new ServiceError("invalid_argument", `${name} is required`)
  return out
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export type MemorySearchResponse = { query: string; results: Awaited<ReturnType<typeof searchMemories>> }
export type AliasResponse = { ok: true; aliases: Awaited<ReturnType<typeof listAliases>> }
export type ContextGrepResponse = { query: string; summaryId: string | null; results: ContextSearchResult[] }

export async function memorySearch(args: ServiceArgs): Promise<MemorySearchResponse> {
  const query = text(args.query, "query")
  return { query, results: await searchMemories(query, optionalNumber(args.limit)) }
}

export async function memoryRead(args: ServiceArgs): Promise<string> {
  return readMemory(args.path, args.start_line, args.end_line, args.hashline)
}

export async function memoryList(): Promise<string> {
  return listMemory()
}

export async function memoryGrep(args: ServiceArgs): Promise<string> {
  return grepMemory(args.query, args.case_insensitive)
}

export async function memoryWrite(args: ServiceArgs): Promise<string> {
  return writeMemory(args.path, args.content, args.mode, args.target)
}

export async function memoryAliasList(): Promise<AliasResponse> {
  return { ok: true, aliases: await listAliases() }
}

export async function memoryAliasSet(args: ServiceArgs): Promise<AliasResponse> {
  return { ok: true, aliases: await setAlias(text(args.handle, "handle"), text(args.canonical, "canonical")) }
}

export async function memoryAliasRemove(args: ServiceArgs): Promise<AliasResponse> {
  return { ok: true, aliases: await removeAlias(text(args.handle, "handle"), optionalText(args.canonical)) }
}

export async function soulRead(args: ServiceArgs): Promise<string> {
  return readSoul(args.hashline)
}

export async function soulWrite(args: ServiceArgs): Promise<string> {
  return writeSoul(args.content, args.mode, args.target)
}

export async function contextGrep(args: ServiceArgs): Promise<ContextGrepResponse> {
  const query = text(args.query, "query")
  const summaryId = optionalText(args.summary_id)
  return { query, summaryId: summaryId ?? null, results: contextArchive().grep(query, optionalNumber(args.limit), summaryId) }
}

export async function contextDescribe(args: ServiceArgs): Promise<unknown> {
  const id = text(args.id, "id")
  const summary = contextArchive().describe(id, optionalNumber(args.token_cap))
  if (!summary) throw new ServiceError("not_found", `unknown context summary: ${id}`)
  return summary
}

export async function contextExpand(args: ServiceArgs): Promise<unknown> {
  const summaryId = text(args.summary_id, "summary_id")
  const summary = contextArchive().expand(summaryId, optionalNumber(args.offset), optionalNumber(args.limit))
  if (!summary) throw new ServiceError("not_found", `unknown context summary: ${summaryId}`)
  return summary
}

export async function discordInbox(args: ServiceArgs): Promise<unknown> {
  const statuses = Array.isArray(args.statuses) || typeof args.statuses === "string"
    ? (args.statuses as string[] | string)
    : undefined
  return listDiscordInbox(optionalNumber(args.limit), statuses)
}

export async function discordBackread(args: ServiceArgs): Promise<unknown> {
  return listDiscordBackread(text(args.channel_id, "channel_id"), optionalNumber(args.limit), optionalText(args.before_message_id))
}

export async function discordSearch(args: ServiceArgs): Promise<unknown> {
  const query = optionalText(args.query)
  const messageId = optionalText(args.message_id)
  const limit = optionalNumber(args.limit)
  return searchDiscordMessages({
    channelId: text(args.channel_id, "channel_id"),
    ...(query ? { query } : {}),
    ...(messageId ? { messageId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
}

export async function discordChannels(): Promise<unknown> {
  return listDiscordChannels()
}

export async function loopBudget(): Promise<LoopBudget> {
  return readLoopBudget()
}

function workService<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof WorkLedgerError) {
      const code = err.message === "unknown work item" ? "not_found" : "invalid_argument"
      throw new ServiceError(code, err.message)
    }
    throw err
  }
}

export async function workCreate(args: ServiceArgs): Promise<WorkItem> {
  return workService(() => createWorkItem({ title: args.title, ...(Object.hasOwn(args, "note") ? { note: args.note } : {}) }))
}

export async function workList(args: ServiceArgs): Promise<WorkItemSummary[]> {
  return workService(() => listWorkItems({ status: args.status, limit: args.limit }))
}

export async function workGet(args: ServiceArgs): Promise<WorkItem> {
  return workService(() => {
    const item = getWorkItem(args.id)
    if (!item) throw new WorkLedgerError("unknown work item")
    return item
  })
}

export async function workUpdate(args: ServiceArgs): Promise<WorkItem> {
  return workService(() => updateWorkItem({ id: args.id, ...(Object.hasOwn(args, "title") ? { title: args.title } : {}), ...(Object.hasOwn(args, "note") ? { note: args.note } : {}), ...(Object.hasOwn(args, "status") ? { status: args.status } : {}) }))
}

export async function workClose(args: ServiceArgs): Promise<WorkItem> {
  return workService(() => closeWorkItem({ id: args.id, status: args.status }))
}

export async function scheduleCreate(args: ServiceArgs): Promise<Schedule> {
  return createSchedule({ message: args.message, at: args.at, delayMs: args.delay_ms, repeatEveryMs: args.repeat_every_ms })
}

export async function scheduleList(args: ServiceArgs): Promise<Schedule[]> {
  return listSchedules(optionalNumber(args.limit))
}

export async function scheduleCancel(args: ServiceArgs): Promise<{ id: string; cancelled: boolean }> {
  return { id: String(args.id ?? ""), cancelled: cancelSchedule(args.id) }
}

/** Every RPC-exposed method, bound to the operation that owns its semantics. */
const OPERATIONS: Record<HostRpcMethod, (args: ServiceArgs) => Promise<unknown>> = {
  "memory.search": memorySearch,
  "memory.read": memoryRead,
  "memory.list": memoryList,
  "memory.grep": memoryGrep,
  "memory.write": memoryWrite,
  "memory.alias.list": memoryAliasList,
  "memory.alias.set": memoryAliasSet,
  "memory.alias.remove": memoryAliasRemove,
  "soul.read": soulRead,
  "soul.write": soulWrite,
  "context.grep": contextGrep,
  "context.describe": contextDescribe,
  "context.expand": contextExpand,
  "discord.inbox": discordInbox,
  "discord.backread": discordBackread,
  "discord.search": discordSearch,
  "discord.channels": discordChannels,
  "loop.budget": loopBudget,
  "work.create": workCreate,
  "work.list": workList,
  "work.get": workGet,
  "work.update": workUpdate,
  "work.close": workClose,
  "schedule.create": scheduleCreate,
  "schedule.list": scheduleList,
  "schedule.cancel": scheduleCancel,
}

/** Host-RPC entry point: dispatch to the same operation the model adapter uses. */
export async function callServerNative(method: HostRpcMethod, args: ServiceArgs): Promise<unknown> {
  return OPERATIONS[method](args)
}
