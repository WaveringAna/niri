import { randomBytes } from "node:crypto"
import { AGENT_ID } from "./agent-config"
import { callServerNative } from "./server-native-services"
import { parseHostRpcRequest, type HostRpcRequest, type HostRpcResult } from "@mira/harness-protocol"

const MAX_RPC_WINDOW_MS = 10 * 60_000
export const HOST_RPC_BODY_LIMIT_BYTES = 512_000
const leases = new Map<string, { invocationId:string; deadlineAt:number; active:boolean }>()

export function issueHostRpcGrant(invocationId: string, deadlineAt: string): string {
  const deadline=Math.min(Date.parse(deadlineAt), Date.now()+MAX_RPC_WINDOW_MS)
  const token=randomBytes(32).toString("base64url")
  leases.set(token,{ invocationId, deadlineAt:deadline, active:true })
  return token
}
export function revokeHostRpcGrant(token: string | undefined): void { if(token) leases.delete(token) }
export function clearHostRpcGrants(): void { leases.clear() }

/** Distinguishes the race's deadline arm from a service failure in the catch below. */
class HostRpcDeadlineError extends Error {}

function result(request: HostRpcRequest, status: HostRpcResult["status"], value?:unknown, error?:{code:string;message:string}): HostRpcResult {
  return { type:"host.result", requestId:request.requestId, status, ...(status === "ok" ? { result:value } : { error:error! }), completedAt:new Date().toISOString() }
}

export async function dispatchHostRpc(raw: unknown, authorization: string | undefined, call: typeof callServerNative = callServerNative): Promise<{statusCode:number; body:HostRpcResult | {error:string}}> {
  const request=parseHostRpcRequest(raw)
  if(!request) return {statusCode:400,body:{error:"invalid host RPC request"}}
  const token=authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
  const lease=leases.get(token)
  if(!lease || !lease.active || lease.invocationId !== request.outerInvocationId) return {statusCode:403,body:{error:"invalid or stale execution grant"}}
  const deadline=Math.min(lease.deadlineAt,Date.parse(request.deadlineAt))
  if(Date.now() >= deadline) { leases.delete(token); return {statusCode:408,body:result(request,"cancelled",undefined,{code:"deadline_exceeded",message:"host RPC deadline expired"})} }
  try {
    console.log(`[host-rpc] agent=${AGENT_ID} invocation=${request.outerInvocationId} request=${request.requestId} method=${request.method}`)
    // Deadline bounds the wait and the caller's grant; it does not cancel an
    // already-running service operation. AbortSignal propagation is deferred
    // until slower or consequential methods are added to the surface.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_,reject)=>{ timer=setTimeout(()=>reject(new HostRpcDeadlineError("host RPC deadline expired")),Math.max(1,deadline-Date.now()));timer.unref?.() })
    const value=await Promise.race([call(request.method,request.args), timeout]).finally(()=>{if(timer) clearTimeout(timer)})
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > HOST_RPC_BODY_LIMIT_BYTES) throw new Error(`host RPC result exceeds ${HOST_RPC_BODY_LIMIT_BYTES} bytes`)
    return {statusCode:200,body:result(request,"ok",value)}
  } catch(error) {
    // A deadline that expires mid-flight answers exactly like one that had
    // already expired at entry. The lease survives: it may still be live for
    // the invocation's next call.
    if(error instanceof HostRpcDeadlineError) return {statusCode:408,body:result(request,"cancelled",undefined,{code:"deadline_exceeded",message:error.message})}
    const code=error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "operation_failed"
    return {statusCode:200,body:result(request,"error",undefined,{code,message:error instanceof Error?error.message:String(error)})}
  }
}
