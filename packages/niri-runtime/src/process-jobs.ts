import { createHash, randomUUID } from "node:crypto"
import type { ClientToolExecutor } from "@mira/harness-core"
import { AGENT_ID } from "./agent-config"
import { getDb } from "./db"
import type { UserMessage } from "./types"

const OUTPUT_LIMIT_BYTES = 512 * 1024
const RESULT_OUTPUT_LIMIT_BYTES = 50 * 1024
const LIST_OUTPUT_LIMIT_BYTES = 1 * 1024
const MAX_COMMAND_CHARS = 100_000
const POLL_DELAY_MS = 2_000
const RETRY_DELAY_MS = 5_000

export type ProcessJobStatus = "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "lost" | "interrupted"
export type ProcessJob = {
  id: string; command: string; clientWorkspaceId: string; sessionId: string | null
  status: ProcessJobStatus; createdAt: string; startedAt: string | null; completedAt: string | null
  exitCode: number | null; signal: string | null; terminationRequested: boolean
  output: string; outputBytes: number; outputTruncated: boolean; lastPollAt: string | null
  lastPollError: string | null; completionEventAt: string | null
}

type Dispatch = (event: UserMessage) => boolean
type Runtime = { clientTools: ClientToolExecutor; dispatch: Dispatch }
let runtime: Runtime | null = null
let tableReady = false
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inflight = new Map<string, Promise<void>>()
const terminationInflight = new Map<string, Promise<void>>()

function ensureTable(): void {
  if (tableReady) return
  getDb().exec(`
    create table if not exists process_jobs (
      id text primary key, command text not null, client_workspace_id text not null, session_id text,
      status text not null check (status in ('starting','running','cancelling','completed','failed','cancelled','lost','interrupted')),
      created_at text not null, started_at text, completed_at text, exit_code integer, signal text,
      termination_requested integer not null default 0, output text not null default '', output_bytes integer not null default 0,
      output_truncated integer not null default 0, last_poll_at text, last_poll_error text, completion_event_at text
    );
    create index if not exists idx_process_jobs_status_created on process_jobs(status, created_at desc);
    create index if not exists idx_process_jobs_completion on process_jobs(completion_event_at, completed_at);
  `)
  tableReady = true
}

function rowToJob(row: Record<string, unknown>): ProcessJob {
  return { id: String(row.id), command: String(row.command), clientWorkspaceId: String(row.client_workspace_id),
    sessionId: typeof row.session_id === "string" ? row.session_id : null, status: row.status as ProcessJobStatus,
    createdAt: String(row.created_at), startedAt: typeof row.started_at === "string" ? row.started_at : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    exitCode: typeof row.exit_code === "number" ? row.exit_code : null, signal: typeof row.signal === "string" ? row.signal : null,
    terminationRequested: Boolean(row.termination_requested), output: String(row.output ?? ""), outputBytes: Number(row.output_bytes ?? 0),
    outputTruncated: Boolean(row.output_truncated), lastPollAt: typeof row.last_poll_at === "string" ? row.last_poll_at : null,
    lastPollError: typeof row.last_poll_error === "string" ? row.last_poll_error : null,
    completionEventAt: typeof row.completion_event_at === "string" ? row.completion_event_at : null }
}
function get(id: string): ProcessJob | null {
  ensureTable(); const row = getDb().prepare("select * from process_jobs where id = ?").get(id) as Record<string, unknown> | undefined
  return row ? rowToJob(row) : null
}
function active(status: ProcessJobStatus): boolean { return status === "starting" || status === "running" || status === "cancelling" }
function tail(value: string, limit: number): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, "utf8"); if (buf.length <= limit) return { value, truncated: false }
  return { value: buf.subarray(buf.length - limit).toString("utf8").replace(/^�/, ""), truncated: true }
}
function mergeOutput(job: ProcessJob, delta: string): { output: string; outputBytes: number; outputTruncated: number } {
  const combined = job.output + delta; const bounded = tail(combined, OUTPUT_LIMIT_BYTES)
  return {
    output: bounded.value,
    outputBytes: job.outputBytes + Buffer.byteLength(delta, "utf8"),
    outputTruncated: job.outputTruncated || bounded.truncated ? 1 : 0,
  }
}
function presentJob(job: ProcessJob, outputLimit = RESULT_OUTPUT_LIMIT_BYTES): ProcessJob {
  const bounded = tail(job.output, outputLimit)
  return { ...job, output: bounded.value, outputTruncated: job.outputTruncated || bounded.truncated }
}
function activeJobs(): ProcessJob[] {
  ensureTable()
  return (getDb().prepare("select * from process_jobs where status in ('starting','running','cancelling') order by created_at").all() as Array<Record<string, unknown>>).map(rowToJob)
}
function jobsNeedingReconciliation(): ProcessJob[] {
  ensureTable()
  return (getDb().prepare("select * from process_jobs where status in ('starting','running','cancelling') or completion_event_at is null order by created_at").all() as Array<Record<string, unknown>>).map(rowToJob)
}
function shellTerminal(status: string, exitCode: number | null): ProcessJobStatus {
  if (status === "terminated") return "cancelled"
  if (status === "exited" && exitCode === 0) return "completed"
  return "failed"
}
function privateCommandLabel(command: string): string {
  const hash = createHash("sha256").update(command).digest("hex").slice(0, 16)
  return `[redacted command sha256:${hash}]`
}
function eventFor(job: ProcessJob): UserMessage {
  const detail = [
    `[process job completed]`, `job_id: ${job.id}`, `status: ${job.status}`,
    `exit_code: ${job.exitCode ?? "null"}`, ...(job.signal ? [`signal: ${job.signal}`] : []),
    `captured_output_bytes: ${job.outputBytes}`,
    ...(job.outputBytes ? ["output: available only through explicit process_job get"] : []),
  ].filter(Boolean).join("\n")
  return { source: "process_job", triggeredAt: job.completedAt ?? new Date().toISOString(), content: detail,
    raw: { type: "process_job", jobId: job.id, status: job.status, sessionId: job.sessionId, exitCode: job.exitCode, signal: job.signal, outputTruncated: job.outputTruncated } }
}
function dispatchCompletion(job: ProcessJob): void {
  if (!runtime || job.completionEventAt) return
  if (runtime.dispatch(eventFor(job))) getDb().prepare("update process_jobs set completion_event_at = ? where id = ? and completion_event_at is null").run(new Date().toISOString(), job.id)
}
function schedule(id: string, delay = POLL_DELAY_MS): void {
  if (!runtime || timers.has(id)) return
  const timer = setTimeout(() => { timers.delete(id); void pollOne(id) }, delay); timer.unref?.(); timers.set(id, timer)
}
function updatePollError(id: string, error: unknown): void {
  getDb().prepare("update process_jobs set last_poll_at = ?, last_poll_error = ? where id = ? and status in ('running','cancelling')").run(new Date().toISOString(), error instanceof Error ? error.message : String(error), id)
}
function finalize(id: string, status: ProcessJobStatus, shell: { output: string; exitCode: number | null; signal: string | null; terminationRequested: boolean }): ProcessJob | null {
  const job = get(id); if (!job || !active(job.status)) return job
  const merged = mergeOutput(job, shell.output)
  const result = getDb().prepare(`update process_jobs set status=?, completed_at=?, exit_code=?, signal=?, termination_requested=?, output=?, output_bytes=?, output_truncated=?, last_poll_at=?, last_poll_error=null where id=? and status in ('starting','running','cancelling')`).run(status, new Date().toISOString(), shell.exitCode, shell.signal, shell.terminationRequested ? 1 : 0, merged.output, merged.outputBytes, merged.outputTruncated, new Date().toISOString(), id)
  const final = get(id); if (result.changes && final) dispatchCompletion(final); return final
}
async function callShell(action: "start" | "poll" | "terminate", job: ProcessJob, command?: string) {
  if (!runtime) throw new Error("process jobs are not initialized")
  const args: Record<string, unknown> = action === "start" ? { action, command, timeout_ms: 1000, max_lines: 0 } : { action, session_id: job.sessionId, timeout_ms: 1000, max_lines: 0 }
  return runtime.clientTools.execute({ agentId: AGENT_ID, tool: "shell", args, timeoutMs: 2_500 })
}
async function pollOneInner(id: string, requestedAction: "poll" | "terminate" = "poll"): Promise<void> {
  const job = get(id); if (!job || !active(job.status) || !job.sessionId) return
  try {
    const result = await callShell(requestedAction, job)
    if (!result.shell) throw new Error("client did not return a structured shell result")
    const shell = result.shell
    if (result.status === "unknown" || shell.status === "unknown") { finalize(id, "lost", { ...shell, signal: shell.signal }); return }
    if (result.status !== "ok") throw new Error(result.output || `client shell result is ${result.status}`)
    if (shell.status === "running") {
      const current = get(id); if (!current || !active(current.status)) return
      const merged = mergeOutput(current, shell.output)
      getDb().prepare("update process_jobs set output=?, output_bytes=?, output_truncated=?, last_poll_at=?, last_poll_error=null, termination_requested=case when termination_requested=1 then 1 else ? end where id=? and status in ('running','cancelling')").run(merged.output, merged.outputBytes, merged.outputTruncated, new Date().toISOString(), shell.terminationRequested ? 1 : 0, id)
      if (!get(id)?.terminationRequested || requestedAction === "terminate") schedule(id)
      return
    }
    finalize(id, shellTerminal(shell.status, shell.exitCode), shell)
  } catch (error) { updatePollError(id, error); schedule(id, RETRY_DELAY_MS) }
}
function runSinglePoll(id: string, action: "poll" | "terminate"): Promise<void> {
  const old = inflight.get(id)
  if (old) return old
  const promise = pollOneInner(id, action).finally(() => inflight.delete(id))
  inflight.set(id, promise)
  return promise
}
function pollOne(id: string, action: "poll" | "terminate" = "poll"): Promise<void> {
  if (action === "poll") return runSinglePoll(id, action)
  const oldTermination = terminationInflight.get(id)
  if (oldTermination) return oldTermination
  const promise = (async () => {
    const oldPoll = inflight.get(id)
    if (oldPoll) await oldPoll
    const job = get(id)
    if (job && active(job.status) && job.sessionId) await runSinglePoll(id, "terminate")
  })().finally(() => terminationInflight.delete(id))
  terminationInflight.set(id, promise)
  return promise
}

export async function startProcessJob(commandValue: unknown): Promise<ProcessJob> {
  ensureTable(); if (!runtime) throw new Error("process jobs are not initialized")
  if (typeof commandValue !== "string") throw new Error("command must be a string")
  const command = commandValue.trim()
  if (!command) throw new Error("command is required")
  if (command.length > MAX_COMMAND_CHARS) throw new Error(`command exceeds ${MAX_COMMAND_CHARS} characters`)
  const workspace = runtime.clientTools.getWorkspace()
  if (!workspace?.shellSessionResults || !runtime.clientTools.getCapabilities().includes("shell")) throw new Error("attached client does not support typed shell sessions")
  const id = `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`, now = new Date().toISOString()
  getDb().prepare("insert into process_jobs (id, command, client_workspace_id, status, created_at) values (?, ?, ?, 'starting', ?)").run(id, privateCommandLabel(command), workspace.id, now)
  const intent = get(id)!
  try {
    const result = await callShell("start", intent, command)
    if (!result.shell || result.status !== "ok") throw new Error(result.output || "client did not return a structured shell result")
    const shell = result.shell; const current = get(id)!; const merged = mergeOutput(current, shell.output)
    if (shell.status === "running") {
      getDb().prepare(`update process_jobs set
        status=case when status='starting' then case when termination_requested=1 then 'cancelling' else 'running' end else status end,
        session_id=?, started_at=coalesce(started_at, ?),
        termination_requested=case when termination_requested=1 then 1 else ? end,
        output=?, output_bytes=?, output_truncated=?, last_poll_at=?
        where id=?`).run(shell.sessionId, now, shell.terminationRequested ? 1 : 0, merged.output, merged.outputBytes, merged.outputTruncated, now, id)
      const started = get(id)
      if (started && active(started.status)) {
        if (started.terminationRequested) await pollOne(id, "terminate")
        else schedule(id)
      } else if (runtime) {
        // Shutdown may have made the intent terminal while the client was starting it.
        // Best-effort termination prevents an untracked live shell.
        try { await callShell("terminate", { ...current, sessionId: shell.sessionId }) } catch { /* client shutdown owns final cleanup */ }
      }
    } else {
      // Keep the client correlation id even when the short start grace observed exit.
      getDb().prepare("update process_jobs set session_id=?, started_at=coalesce(started_at, ?) where id=?").run(shell.sessionId, now, id)
      finalize(id, shellTerminal(shell.status, shell.exitCode), shell)
    }
  } catch (error) {
    const current = get(id); if (current && current.status === "starting") {
      const merged = mergeOutput(current, error instanceof Error ? error.message : String(error))
      getDb().prepare("update process_jobs set status='failed', completed_at=?, output=?, output_bytes=?, output_truncated=?, last_poll_error=? where id=? and status='starting'").run(new Date().toISOString(), merged.output, merged.outputBytes, merged.outputTruncated, error instanceof Error ? error.message : String(error), id)
      const failed = get(id); if (failed) dispatchCompletion(failed)
    }
  }
  return presentJob(get(id)!)
}
function processJobId(idValue: unknown): string {
  if (typeof idValue !== "string" || !/^job_[a-f0-9]{16}$/u.test(idValue.trim())) throw new Error("invalid process job id")
  return idValue.trim()
}
export function getProcessJob(idValue: unknown): ProcessJob {
  const job = get(processJobId(idValue)); if (!job) throw new Error("process job not found")
  return presentJob(job)
}
export function listProcessJobs(limitValue?: unknown): ProcessJob[] {
  ensureTable()
  const limit = limitValue === undefined || limitValue === null ? 20 : limitValue
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100")
  return (getDb().prepare("select * from process_jobs order by created_at desc limit ?").all(limit) as Array<Record<string, unknown>>)
    .map(rowToJob)
    .map((job) => presentJob(job, LIST_OUTPUT_LIMIT_BYTES))
}
export async function cancelProcessJob(idValue: unknown): Promise<ProcessJob> {
  const id = processJobId(idValue); let job = get(id); if (!job) throw new Error("process job not found")
  if (!active(job.status)) return presentJob(job)
  getDb().prepare("update process_jobs set status='cancelling', termination_requested=1 where id=? and status in ('starting','running')").run(id)
  job = get(id)!; if (job.sessionId) await pollOne(id, "terminate"); return presentJob(get(id)!)
}
/** Reconcile persisted intent only. It never replays a command. */
export function initProcessJobs(clientTools: ClientToolExecutor, dispatch: Dispatch): void {
  ensureTable(); runtime = { clientTools, dispatch }
  for (const job of jobsNeedingReconciliation()) {
    if (!active(job.status)) { dispatchCompletion(job); continue }
    const workspace = clientTools.getWorkspace()
    if (!workspace?.shellSessionResults || workspace.id !== job.clientWorkspaceId || !job.sessionId) {
      const result = getDb().prepare("update process_jobs set status='lost', completed_at=?, last_poll_error=? where id=? and status in ('starting','running','cancelling')").run(new Date().toISOString(), "client shell session unavailable after restart; command was not replayed", job.id)
      if (result.changes) { const lost = get(job.id); if (lost) dispatchCompletion(lost) }
    } else schedule(job.id, 0)
  }
}
export async function stopProcessJobs(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer); timers.clear()
  const jobs = activeJobs()
  await Promise.all(jobs.map(async (job) => { try { await cancelProcessJob(job.id) } catch { /* preserve uncertain record */ } }))
  for (const job of activeJobs()) getDb().prepare("update process_jobs set status='interrupted', completed_at=?, last_poll_error=? where id=? and status in ('starting','running','cancelling')").run(new Date().toISOString(), "runtime stopped before shell termination could be confirmed", job.id)
  runtime = null
}
export const __processJobsTest = { ensureTable, eventFor, pollOne, finalize }
