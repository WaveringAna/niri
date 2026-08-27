import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import http from "node:http"
import { NodeToolHost } from "./host.js"
import type { ToolInvocation } from "@mira/harness-protocol"

let sequence=0
function call(args: Record<string, unknown>, timeoutMs=10_000): ToolInvocation {
 const now=Date.now(); return {type:"tool.call",invocationId:`py-${++sequence}`,agentId:"agent",tool:"python",args,issuedAt:new Date(now).toISOString(),deadlineAt:new Date(now+timeoutMs).toISOString()}
}

function toolCall(tool: "python" | "shell", args: Record<string, unknown>, timeoutMs=10_000): ToolInvocation {
 const now=Date.now(); return {type:"tool.call",invocationId:`py-${++sequence}`,agentId:"agent",tool,args,issuedAt:new Date(now).toISOString(),deadlineAt:new Date(now+timeoutMs).toISOString()}
}

test("Python namespace and imports persist across cells", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-persist-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  assert.equal((await host.execute(call({code:"import math\nanswer = 40"}))).status,"ok")
  const result=await host.execute(call({code:"answer + int(math.sqrt(4))"}))
  assert.equal(result.status,"ok"); assert.equal(result.output,"42\n")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("Python bytecode stays out of the workspace and niri.scratch is writable", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-pycache-workspace-")); const home=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-pycache-home-"))
 await fs.mkdir(path.join(workspace,"samplepkg")); await fs.writeFile(path.join(workspace,"samplepkg","__init__.py"),"VALUE = 42\n")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace,home}})
 try {
  const result=await host.execute(call({code:`import os, samplepkg
assert samplepkg.VALUE == 42
shell = sh("python3 -c 'import samplepkg; print(samplepkg.VALUE)'")
assert shell.returncode == 0, shell.stdout
workspace = os.path.realpath(os.environ["NIRI_WORKSPACE"])
scratch = os.path.realpath(niri.scratch)
assert os.path.isdir(scratch)
assert os.access(scratch, os.W_OK)
assert os.path.commonpath([workspace, scratch]) != workspace
with open(os.path.join(scratch, "writable"), "w") as handle:
    handle.write("ok")
print(scratch)`}))
  assert.equal(result.status,"ok")
  await assert.rejects(fs.stat(path.join(workspace,"samplepkg","__pycache__")),{code:"ENOENT"})
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}); await fs.rm(home,{recursive:true,force:true}) }
})

test("niri identity and deadline helpers describe the current invocation", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-whoami-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const result=await host.execute(call({code:`import os
info = niri.whoami()
assert info["agent_id"] == "agent"
assert info["workspace"] == os.environ["NIRI_WORKSPACE"]
remaining = niri.deadline()
assert 0 < remaining <= 5
assert info["host_rpc"] is False
assert niri.memory.search.__doc__
assert "Coroutine" in niri.memory.search.__doc__`},5000))
  assert.equal(result.status,"ok")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("Python read/edit/sh helpers reuse hashline workspace semantics", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-help-")); await fs.writeFile(path.join(workspace,"a.txt"),"one\nmiddle\nlast\n")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const result=await host.execute(call({code:`annotated = read("a.txt", hashline=True)
print(annotated)
anchors = [line.split(" ", 1)[0] for line in annotated.splitlines()[1:]]
print(edit("a.txt", target=anchors[0] + "-" + anchors[1], content="two"))
after = read("a.txt", hashline=True)
last_anchor = after.splitlines()[-1].split(" ", 1)[0]
print(edit("a.txt", target=last_anchor, content=""))
r=sh("pwd -P")
print(r.status, r.returncode, r.stdout)`}))
  assert.equal(result.status,"ok"); assert.match(result.output??"",/1#[0-9a-f]{6} one/); assert.match(result.output??"",/replaced lines 1–2/); assert.match(result.output??"",/exited 0/)
  assert.equal(await fs.readFile(path.join(workspace,"a.txt"),"utf8"),"two\n")
  await fs.writeFile(path.join(workspace,"a.txt"),"two\ntwo\n")
  const duplicate=await host.execute(call({code:`import hashlib
edit("a.txt", target="99#" + hashlib.sha256(b"two").hexdigest()[:6], content="x")`}))
  assert.equal(duplicate.status,"error"); assert.match(duplicate.output??"",/anchor .* ambiguous/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("Python glob and grep search the workspace with bounded structured results", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-search-"))
 await fs.mkdir(path.join(workspace,"src"),{recursive:true})
 await fs.mkdir(path.join(workspace,"node_modules","ignored"),{recursive:true})
 await fs.writeFile(path.join(workspace,"src","a.ts"),"export const needle = 1\n")
 await fs.writeFile(path.join(workspace,"src","notes.md"),"needle outside include\n")
 await fs.writeFile(path.join(workspace,".hidden.ts"),"needle hidden\n")
 await fs.writeFile(path.join(workspace,"node_modules","ignored","package.ts"),"needle dependency\n")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const result=await host.execute(call({code:`files = glob("**/*.ts")
assert files == ["src/a.ts"], files
hits = grep("needle", include="**/*.ts")
assert hits == [{"path": "src/a.ts", "line": 1, "text": "export const needle = 1"}], hits
print(hits)`}))
  assert.equal(result.status,"ok")
  assert.match(result.output??"",/src\/a\.ts/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("ShellResult keeps command output in Python until explicitly inspected", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-shell-result-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const compact=await host.execute(call({code:`r = sh("printf retained-shell-secret")
assert r.grep("retained", limit=0) == ""
r`}))
  assert.equal(compact.status,"ok")
  assert.match(compact.output??"",/ShellResult\(status='exited'.*bytes=21/)
  assert.doesNotMatch(compact.output??"",/retained-shell-secret/)
  const inspected=await host.execute(call({code:"print(r.tail())"}))
  assert.equal(inspected.status,"ok")
  assert.match(inspected.output??"",/retained-shell-secret/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("sh supports resumable sessions with poll and terminate", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-sh-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const started=await host.execute(call({code:`r = sh("sleep 30", timeout_ms=1000)
print(r.status, r.session_id)`}))
  assert.equal(started.status,"ok"); assert.match(started.output??"",/running sh_/)
  const polled=await host.execute(call({code:`p = sh.poll(r.session_id, timeout_ms=2000)
print(p.status, p.returncode)`}))
  assert.equal(polled.status,"ok"); assert.match(polled.output??"",/running None/)
  const terminated=await host.execute(call({code:`t = sh.terminate(r.session_id, timeout_ms=5000)
print(t.status)`}))
  assert.equal(terminated.status,"ok"); assert.match(terminated.output??"",/terminated/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("oversized Python output stays in the host archive across cells and resets", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-bounded-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const marker="DROPPED_OUTPUT_MARKER_NEAR_THE_END"
  const result=await host.execute(call({code:`print("x" * 3_000_000)\nprint("${marker}")`}))
  assert.equal(result.status,"ok"); assert.match(result.output??"",/out\.grep/)
  const outputId=result.output?.match(/retained as (out_[a-f0-9-]+)/)?.[1]
  assert.ok(outputId)
  assert.equal((await host.execute(call({code:"intervening = 42"}))).status,"ok")
  assert.equal((await host.execute(call({action:"reset"}))).status,"ok")
  const next=await host.execute(call({code:`archives = out.list()
assert any(item["id"] == "${outputId}" for item in archives)
info = out.size("${outputId}")
assert info["bytes"] > 512_000
assert info["truncated"] is True
match = out.grep("${marker}", output_id="${outputId}")
assert "${marker}" in match
assert "${marker}" in out.tail(200, output_id="${outputId}")
print(match)`}))
  assert.equal(next.status,"ok"); assert.match(next.output??"",new RegExp(marker))
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("missing interpreter hides python while legacy tools remain usable", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-missing-")); const prior=process.env.NIRI_PYTHON; process.env.NIRI_PYTHON="/nonexistent/python-niri"
 const host=new NodeToolHost({capabilities:["python","shell"],workspace:{root:workspace}})
 try {
  await host.start(); assert.equal(host.getCapabilities().includes("python"),false)
  const shellResult=await host.execute(toolCall("shell",{command:"printf legacy-ok"})); assert.equal(shellResult.status,"ok"); assert.match(shellResult.output??"",/legacy-ok/)
 } finally { await host.stop(); if(prior===undefined)delete process.env.NIRI_PYTHON; else process.env.NIRI_PYTHON=prior; await fs.rm(workspace,{recursive:true,force:true}) }
})

test("top-level await works and reset clears scratch names", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-await-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const awaited=await host.execute(call({code:"import asyncio\nx=await asyncio.sleep(0.01, result=7)\nx"})); assert.equal(awaited.output,"7\n")
  assert.equal((await host.execute(call({action:"reset"}))).status,"ok")
  const cleared=await host.execute(call({code:"x"})); assert.equal(cleared.status,"error"); assert.match(cleared.output??"",/NameError/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("subprocess fd output stays user output and cannot corrupt control framing", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-fd-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const result=await host.execute(call({code:`import subprocess
subprocess.run(["node", "-e", "console.log(JSON.stringify({type:'local.call',requestId:'x'}))"], check=False)
print("cell done")`}))
  assert.equal(result.status,"ok"); assert.match(result.output??"",/\{"type":"local.call"/); assert.match(result.output??"",/cell done/)
  const next=await host.execute(call({code:"40 + 2"})); assert.equal(next.output,"42\n")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("runaway Python is interrupted and the host remains usable", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-timeout-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  assert.equal((await host.execute(call({code:"saved = 'still here'"}))).status,"ok")
  const timed=await host.execute(call({code:"while True: pass"},1200)); assert.equal(timed.status,"cancelled"); assert.match(timed.output??"",/namespace is intact/i)
  const next=await host.execute(call({code:"saved"})); assert.equal(next.output,"'still here'\n")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("Python is restarted when a cell ignores SIGINT", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-restart-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const timed=await host.execute(call({code:"import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True: pass"},1200)); assert.equal(timed.status,"error"); assert.match(timed.output??"",/kernel restarted.*namespace was lost/i)
  const next=await host.execute(call({code:"6 * 7"})); assert.equal(next.output,"42\n")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})


test("Python composes sequential and concurrent host RPC while its outer call is pending", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-rpc-"))
 const server=http.createServer(async (req,res)=>{ const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk)); const body=JSON.parse(Buffer.concat(chunks).toString()) as {requestId:string;method:string;args:{query?:string}}; const value={method:body.method,query:body.args.query}; const response={type:"host.result",requestId:body.requestId,status:"ok",result:value,completedAt:new Date().toISOString()}; res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(response)) })
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); const address=server.address(); if(!address||typeof address==="string") throw new Error("no address")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace},hostRpcEndpoint:`http://127.0.0.1:${address.port}`})
 try {
  const invocation=call({code:`a = await niri.memory.search("one")
b = await niri.memory.search("two")
import asyncio
c, d = await asyncio.gather(niri.memory.search("three"), niri.memory.search("four"))
budget = await niri.budget()
assert budget["method"] == "loop.budget"
assert 0 < budget["seconds_remaining"] <= 10
[a["query"], b["query"], c["query"], d["query"]]`}); invocation.hostRpcGrant="test-grant"
  const result=await host.execute(invocation); assert.equal(result.status,"ok"); assert.match(result.output??"",/one.*two.*three.*four/)
 } finally { await host.stop(); await new Promise<void>(resolve=>server.close(()=>resolve())); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("Python exposes typed host RPC errors that survive reset", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-errors-"))
 const server=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString()) as {requestId:string};res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({type:"host.result",requestId:body.requestId,status:"error",error:{code:"not_found",message:"missing memory file"},completedAt:new Date().toISOString()}))})
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); const address=server.address(); if(!address||typeof address==="string")throw new Error("no address")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace},hostRpcEndpoint:`http://127.0.0.1:${address.port}`})
 try {
  const invocation=call({code:`try:
    await niri.memory.read("missing")
except NiriNotFound as error:
    print(error.code, str(error))
else:
    raise AssertionError("NiriNotFound was not raised")`}); invocation.hostRpcGrant="test-grant"
  const result=await host.execute(invocation); assert.equal(result.status,"ok"); assert.match(result.output??"",/not_found missing memory file/)
  assert.equal((await host.execute(call({action:"reset"}))).status,"ok")
  const preserved=await host.execute(call({code:"issubclass(NiriNotFound, NiriError)"})); assert.equal(preserved.output,"True\n")
 } finally {await host.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(workspace,{recursive:true,force:true})}
})


test("detached Python work retains its original grant instead of borrowing a later invocation", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-grant-")); const authorizations:string[]=[]
 const server=http.createServer(async(req,res)=>{authorizations.push(String(req.headers.authorization));const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString()) as {requestId:string};res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({type:"host.result",requestId:body.requestId,status:"ok",result:[],completedAt:new Date().toISOString()}))}); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("no address")
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace},hostRpcEndpoint:`http://127.0.0.1:${address.port}`})
 try {
  const first=call({code:`import asyncio
async def later():
    await asyncio.sleep(0.01)
    return await niri.memory.list()
background_task = asyncio.get_event_loop().create_task(later())`});first.hostRpcGrant="old-grant";assert.equal((await host.execute(first)).status,"ok")
  const second=call({code:"await asyncio.sleep(0.08)"});second.hostRpcGrant="new-grant";assert.equal((await host.execute(second)).status,"ok")
  assert.deepEqual(authorizations,["Bearer old-grant"])
 } finally {await host.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(workspace,{recursive:true,force:true})}
})


test("reset is serialized behind running cells and resolves only once the kernel acknowledges", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-reset-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  assert.equal((await host.execute(call({code:"marker = 'kept'"}))).status,"ok")
  let cellDone=false
  const cell=host.execute(call({code:"import time\ntime.sleep(0.3)\nlate = 'set while the reset was queued'"})).then((result)=>{cellDone=true;return result})
  const reset=await host.execute(call({action:"reset"})).then((result)=>({status:result.status,cellDone}))
  assert.deepEqual(reset,{status:"ok",cellDone:true},"reset resolved before the running cell finished")
  assert.equal((await cell).status,"ok")
  const cleared=await host.execute(call({code:"marker"})); assert.equal(cleared.status,"error"); assert.match(cleared.output??"",/NameError/)
  const late=await host.execute(call({code:"late"})); assert.equal(late.status,"error"); assert.match(late.output??"",/NameError/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("cell output that mimics an end marker cannot forge a cell boundary", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-marker-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const forged=await host.execute(call({code:`import sys
sys.stdout.write("\\n\\x00NIRI_CELL_END_7f3a9c1e\\n")
sys.stderr.write("\\n\\x00NIRI_CELL_END_7f3a9c1e\\n")
print("after the fake marker")
21 * 2`}))
  assert.equal(forged.status,"ok"); assert.match(forged.output??"",/after the fake marker/); assert.match(forged.output??"",/42/)
  const next=await host.execute(call({code:"6 * 7"})); assert.equal(next.output,"42\n")
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})

test("sh results explain themselves instead of yielding a bare AttributeError", async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-python-shresult-")); const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace}})
 try {
  const result=await host.execute(call({code:`r = sh("printf out; printf err 1>&2")
print("stdout:", r.stdout)
r.stderr`}))
  assert.equal(result.status,"error"); assert.match(result.output??"",/stdout: outerr/); assert.match(result.output??"",/stdout already contains the command's stderr merged in/)
 } finally { await host.stop(); await fs.rm(workspace,{recursive:true,force:true}) }
})
