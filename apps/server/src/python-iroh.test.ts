import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { EndpointTicket, SecretKey } from "@number0/iroh"
import { NodeToolHost, ToolClientHttpServer } from "@mira/harness-client-node"
import type { ToolInvocation } from "@mira/harness-protocol"
import { AWP_ALPN, bindEndpoint, openSocketStream, startConnectionTunnel } from "@niri/iroh-transport"

test("outer Python and nested reverse host RPC complete over opposite iroh BiStreams", async (t) => {
 const serverEndpoint=await bindEndpoint(SecretKey.generate().toBytes(),{preset:"minimal"}); const clientEndpoint=await bindEndpoint(SecretKey.generate().toBytes(),{preset:"minimal"})
 t.after(async()=>{await serverEndpoint.close().catch(()=>{});await clientEndpoint.close().catch(()=>{})})
 const accepted=(async()=>{const incoming=await serverEndpoint.acceptNext();if(!incoming)throw new Error("no connection");return (await incoming.accept()).connect()})()
 const clientConnection=await clientEndpoint.connect(EndpointTicket.fromAddr(serverEndpoint.addr()).endpointAddr(),AWP_ALPN); const serverConnection=await accepted
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"niri-iroh-python-")); t.after(()=>fs.rm(workspace,{recursive:true,force:true}))
 const reverseTunnel=await startConnectionTunnel(clientConnection); t.after(()=>reverseTunnel.close())
 const host=new NodeToolHost({capabilities:["python"],workspace:{root:workspace},hostRpcEndpoint:reverseTunnel.url}); const toolServer=new ToolClientHttpServer({host,listenHost:"127.0.0.1",port:0}); const toolAddress=await toolServer.start(); t.after(()=>toolServer.stop())
 const rpcServer=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString()) as {requestId:string,args:{query:string}};res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({type:"host.result",requestId:body.requestId,status:"ok",result:{results:[body.args.query]},completedAt:new Date().toISOString()}))}); await new Promise<void>(resolve=>rpcServer.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>rpcServer.close(()=>resolve()))); const rpcPort=(rpcServer.address() as net.AddressInfo).port
 let live=true; const clientAccept=(async()=>{while(live){try{await openSocketStream(clientConnection,toolAddress.port)}catch{return}}})(); const serverAccept=(async()=>{while(live){try{await openSocketStream(serverConnection,rpcPort)}catch{return}}})(); t.after(()=>{live=false;clientConnection.close(0n,[]);serverConnection.close(0n,[]);void clientAccept;void serverAccept})
 const outerTunnel=await startConnectionTunnel(serverConnection);t.after(()=>outerTunnel.close())
 const now=Date.now();const invocation:ToolInvocation={type:"tool.call",invocationId:"outer-1",agentId:"agent-a",tool:"python",args:{code:`first = await niri.memory.search("deployment")
second = await niri.memory.search("release")
[first["results"][0], second["results"][0]]`},issuedAt:new Date(now).toISOString(),deadlineAt:new Date(now+10000).toISOString(),hostRpcGrant:"short-lived-test-grant"}
 const response=await fetch(`${outerTunnel.url}/tools/python`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(invocation),signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const result=await response.json() as {status:string;output?:string};assert.equal(result.status,"ok");assert.match(result.output??"",/deployment.*release/)
})
