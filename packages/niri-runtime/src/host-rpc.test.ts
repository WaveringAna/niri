import assert from "node:assert/strict"
import test from "node:test"
import { dispatchHostRpc, issueHostRpcGrant, revokeHostRpcGrant } from "./host-rpc"
import { parseHostRpcRequest } from "@mira/harness-protocol"
import { setLoopBudget } from "./runner/loop-budget"
import { ServiceError } from "./server-native-services"

function request(invocation="outer", deadline=Date.now()+5000) { const now=new Date(); return {type:"host.call",requestId:"r1",outerInvocationId:invocation,method:"memory.search",args:{query:"x"},issuedAt:now.toISOString(),deadlineAt:new Date(deadline).toISOString()} }

test("host RPC grants are active-invocation leases and cannot be spoofed or reused", async () => {
 const deadline=new Date(Date.now()+5000).toISOString(); const grant=issueHostRpcGrant("outer",deadline); const call=async()=>({safe:true})
 assert.equal((await dispatchHostRpc(request("other"),`Bearer ${grant}`,call as never)).statusCode,403)
 const ok=await dispatchHostRpc(request(),`Bearer ${grant}`,call as never); assert.equal(ok.statusCode,200); assert.equal("status" in ok.body?ok.body.status:null,"ok")
 revokeHostRpcGrant(grant)
 assert.equal((await dispatchHostRpc(request(),`Bearer ${grant}`,call as never)).statusCode,403)
})

test("expired grants and malformed requests fail before dispatch", async () => {
 const expired=issueHostRpcGrant("outer",new Date(Date.now()-1).toISOString()); let called=false; const call=async()=>{called=true;return null}
 assert.equal((await dispatchHostRpc(request("outer",Date.now()+1000),`Bearer ${expired}`,call as never)).statusCode,408); assert.equal(called,false)
 assert.equal((await dispatchHostRpc({...request(),method:"python"},"Bearer none",call as never)).statusCode,400)
})

test("loop budget reports token usage and context size without a turn limit", async () => {
 const deadline=new Date(Date.now()+5000).toISOString(); const grant=issueHostRpcGrant("outer",deadline)
 const raw={...request(),method:"loop.budget",args:{}}
 assert.equal(parseHostRpcRequest(raw)?.method,"loop.budget")
 setLoopBudget({tokenCount:123,contextSize:456})
 const response=await dispatchHostRpc(raw,`Bearer ${grant}`)
 assert.deepEqual("result" in response.body?response.body.result:null,{tokenCount:123,contextSize:456})
 setLoopBudget({tokenCount:789})
 const updated=await dispatchHostRpc(raw,`Bearer ${grant}`)
 assert.deepEqual("result" in updated.body?updated.body.result:null,{tokenCount:789,contextSize:456})
 revokeHostRpcGrant(grant)
})

test("service errors retain typed codes through host RPC", async () => {
 const deadline=new Date(Date.now()+5000).toISOString(); const grant=issueHostRpcGrant("outer",deadline)
 const invalid=await dispatchHostRpc({...request(),method:"memory.search",args:{query:""}},`Bearer ${grant}`)
 assert.equal("error" in invalid.body&&typeof invalid.body.error==="object"?invalid.body.error?.code:null,"invalid_argument")
 const missing=await dispatchHostRpc(request(),`Bearer ${grant}`,(async()=>{throw new ServiceError("not_found","unknown context summary: missing-summary")}) as never)
 assert.equal("error" in missing.body&&typeof missing.body.error==="object"?missing.body.error?.code:null,"not_found")
 const generic=await dispatchHostRpc(request(),`Bearer ${grant}`,(async()=>{throw new Error("boom")}) as never)
 assert.equal("error" in generic.body&&typeof generic.body.error==="object"?generic.body.error?.code:null,"operation_failed")
 revokeHostRpcGrant(grant)
})


test("host RPC rejects oversized service results",async()=>{
 const deadline=new Date(Date.now()+5000).toISOString();const grant=issueHostRpcGrant("outer",deadline)
 const response=await dispatchHostRpc(request(),`Bearer ${grant}`,async()=>"x".repeat(600_000) as never)
 assert.equal(response.statusCode,200);assert.equal("status" in response.body?response.body.status:null,"error");assert.match("error" in response.body&&typeof response.body.error==="object"?String(response.body.error?.message):"",/exceeds 512000 bytes/)
 revokeHostRpcGrant(grant)
})

test("a deadline that expires mid-flight is cancelled, not an operation failure",async()=>{
 const grant=issueHostRpcGrant("outer",new Date(Date.now()+5000).toISOString())
 const slow=async()=>new Promise(resolve=>{const timer=setTimeout(()=>resolve("too late"),5000);timer.unref?.()})
 const response=await dispatchHostRpc(request("outer",Date.now()+120),`Bearer ${grant}`,slow as never)
 assert.equal(response.statusCode,408)
 assert.equal("status" in response.body?response.body.status:null,"cancelled")
 assert.equal("error" in response.body&&typeof response.body.error==="object"?response.body.error?.code:null,"deadline_exceeded")
 // The lease outlives one call's deadline: the invocation can still call again.
 assert.equal((await dispatchHostRpc(request(),`Bearer ${grant}`,(async()=>({ok:true})) as never)).statusCode,200)
 revokeHostRpcGrant(grant)
})
