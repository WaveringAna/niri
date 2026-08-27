import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { standaloneEnvironment } from "./standalone-config"

test("standalone YAML topology binds an isolated identity, home, workspace, client, and port",()=>{
 const cwd=path.resolve("/tmp/niri-standalone-test")
 const env=standaloneEnvironment({id:"fresh",name:"Fresh",port:4567,home:"state/fresh",client:"local",workspace:"repos/toy",model:{name:"test"}},"/tmp/fresh.yaml",{PATH:"/bin",HOME:"/wrong",PORT:"9999"},cwd)
 assert.equal(env.NIRI_AGENT_ID,"fresh");assert.equal(env.AGENT_ID,"fresh");assert.equal(env.AGENT_NAME,"Fresh")
 assert.equal(env.HOME,path.join(cwd,"state/fresh"));assert.equal(env.NIRI_HOME,path.join(cwd,"state/fresh"))
 assert.equal(env.NIRI_CLIENT,"local");assert.equal(env.NIRI_CLIENT_WORKSPACE,path.join(cwd,"repos/toy"));assert.equal(env.PORT,"4567")
 assert.equal(env.NIRI_MIGRATE_LEGACY_STATE,"false")
})
