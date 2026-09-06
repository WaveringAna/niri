import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { createElement, type ReactElement } from "react"
import { render, type Instance } from "ink"
import { AgentsView } from "./agents-view.js"
import { RootApp } from "./app.js"
import { ChatScreen } from "./chat.js"
import { CreateFlow } from "./create.js"
import { NiriClient } from "../client.js"

const strip = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5) })
const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt++) { if (ready()) return; await tick() }
  throw new Error(`timed out waiting for ${what}`)
}

type Screen = { app: Instance; press: (keys: string) => Promise<void>; last: () => string; all: () => string; raw: () => string; shows: (text: string) => Promise<void> }

/** Mount a screen on injected streams that look like a terminal to Ink. */
const mount = (node: ReactElement, t: { after: (fn: () => void) => void }): Screen => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  const frames: string[] = []
  ;(stdout as unknown as PassThrough).on("data", (chunk: Buffer) => { frames.push(String(chunk)) })
  const app = render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  t.after(() => { app.unmount() })
  // Ink brackets every frame with erase-only writes; the last painted frame is the screen.
  const painted = (): string => strip([...frames].reverse().find((frame) => strip(frame).trim()) ?? "")
  const screen: Screen = {
    app,
    // One keystroke per chunk: a chunk with several characters is a paste, not typing.
    press: async (keys) => { (stdin as unknown as PassThrough).write(keys); await tick() },
    last: painted,
    all: () => strip(frames.join("")),
    raw: () => frames.join(""),
    shows: (text) => until(() => screen.all().includes(text), `screen text ${JSON.stringify(text)}`),
  }
  return screen
}

const listing = (agents: unknown[], calls: string[] = []): { client: NiriClient; calls: string[] } => ({
  client: new NiriClient({ baseUrl: "https://control.test", fetchImpl: async (url) => { calls.push(String(url)); return json({ agents }) } }),
  calls,
})

test("the agents view lists rows, moves the selection and opens a chat", async (t) => {
  const { client } = listing([
    { id: "alpha", application: { state: "active", activeRevision: 4 }, model: { name: "gpt-4.1-mini" } },
    { id: "beta", status: "stopped", revision: 2 },
  ])
  const chats: string[] = []
  const screen = mount(createElement(AgentsView, { client, onChat: (id: string) => chats.push(id), onCreate: () => {}, onQuit: () => {} }), t)
  await screen.shows("alpha")
  await screen.shows("gpt-4.1-mini")
  assert.match(screen.last(), /> \u25cf alpha/)
  await screen.press("j")
  await until(() => /> \u25cf beta/.test(screen.last()), "beta selected")
  await screen.press("\r")
  await until(() => chats.length === 1, "chat opened")
  assert.deepEqual(chats, ["beta"])
})

test("the agents view refreshes on r, creates on c, quits on q and stops polling when unmounted", async (t) => {
  const { client, calls } = listing([{ id: "alpha", status: "running" }])
  let created = 0; let quit = 0
  const screen = mount(createElement(AgentsView, { client, onChat: () => {}, onCreate: () => { created++ }, onQuit: () => { quit++ }, refreshMs: 20 }), t)
  await screen.shows("alpha")
  await screen.press("r")
  await until(() => calls.length >= 2, "manual refresh")
  await until(() => calls.length >= 4, "background refresh")
  await screen.press("c"); await screen.press("q")
  await until(() => created === 1 && quit === 1, "create and quit")
  screen.app.unmount()
  const settled = calls.length
  await new Promise((resolve) => { setTimeout(resolve, 80) })
  assert.equal(calls.length, settled, "no polling after unmount")
})

test("an unreachable server shows the offline hint, an empty server the create hint", async (t) => {
  const offline = new NiriClient({ baseUrl: "https://control.test", fetchImpl: async () => { throw new Error("connect ECONNREFUSED") } })
  const down = mount(createElement(AgentsView, { client: offline, onChat: () => {}, onCreate: () => {}, onQuit: () => {} }), t)
  await down.shows("offline")
  await down.shows("no server? run `niri serve` to start one")
  const { client } = listing([])
  const empty = mount(createElement(AgentsView, { client, onChat: () => {}, onCreate: () => {}, onQuit: () => {} }), t)
  await empty.shows("no agents yet")
  await empty.shows("press c to create a stopped draft")
})

type Post = { url: string; body: Record<string, unknown> }
const creator = (reply: unknown): { client: NiriClient; posts: Post[] } => {
  const posts: Post[] = []
  const client = new NiriClient({
    baseUrl: "https://control.test",
    fetchImpl: async (url, init) => { posts.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return json(reply) },
  })
  return { client, posts }
}

test("the create flow asks for an id, provider, model, key and discord, then posts one config", async (t) => {
  const { client, posts } = creator({ id: "lyra", revision: 1, config: {} })
  let done = 0
  const screen = mount(createElement(CreateFlow, { client, onDone: () => { done++ } }), t)
  await screen.shows("new agent id:")
  for (const answer of ["lyra", "anthropic", "claude-test", "", "env:MY_KEY", "y", "bot-token", "42"]) {
    await screen.press(answer); await screen.press("\r")
  }
  await until(() => posts.length === 1, "create request")
  assert.equal(posts[0]!.url, "https://control.test/agents")
  assert.deepEqual(posts[0]!.body, {
    id: "lyra",
    config: {
      model: { provider: "anthropic", name: "claude-test" },
      secrets: { "model.apiKey": { env: "MY_KEY" } },
      discord: { enabled: true, token: "bot-token", dmWhitelist: "42" },
    },
    start: false,
  })
  await screen.shows("api base url (enter for https://api.anthropic.com)")
  await screen.shows("no model set yet")
  await screen.shows("niri agents start lyra")
  await screen.press("\r")
  await until(() => done === 1, "flow closed")
})

test("a named create keeps openai by default, sends a pasted key, and skipping everything creates a bare agent", async (t) => {
  const named = creator({ id: "nova", revision: 1, config: { model: { name: "test-model" } } })
  const first = mount(createElement(CreateFlow, { client: named.client, id: "nova", onDone: () => {} }), t)
  await first.shows("model provider")
  for (const answer of ["", "test-model", "https://api.deepseek.com", "test-key", "n"]) { await first.press(answer); await first.press("\r") }
  await until(() => named.posts.length === 1, "create request")
  assert.deepEqual(named.posts[0]!.body.config, { model: { provider: "openai", name: "test-model", baseUrl: "https://api.deepseek.com", apiKey: "test-key" } })
  await first.shows("agent nova is saved and stopped.")

  const bare = creator({ id: "draft", revision: 1, config: {} })
  const second = mount(createElement(CreateFlow, { client: bare.client, id: "draft", onDone: () => {} }), t)
  await second.shows("model provider")
  for (let field = 0; field < 5; field++) { await second.press("\r") }
  await until(() => bare.posts.length === 1, "bare create request")
  assert.deepEqual(bare.posts[0]!.body, { id: "draft", start: false })
})

test("backspace edits the answer and never eats the prompt", async (t) => {
  const { client } = creator({ id: "draft", config: {} })
  const screen = mount(createElement(CreateFlow, { client, onDone: () => {} }), t)
  await screen.shows("new agent id:")
  await screen.press("ab")
  await until(() => screen.last().includes("new agent id: ab"), "typed answer")
  for (let stroke = 0; stroke < 6; stroke++) { await screen.press("\u007f") }
  assert.match(screen.last(), /new agent id:/)
  assert.equal(screen.last().includes("ab"), false)
})

/** A fake control server: one open SSE stream, a status flag, and recorded posts. */
const control = () => {
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const posts: Post[] = []
  const state = { running: true, idle: false }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { sink = controller } }), { status: 200 })
    if (url.endsWith("/status")) return json(state)
    posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return json({ ok: true })
  }
  return {
    fetchImpl, posts, state,
    ready: () => until(() => sink !== undefined, "stream subscription"),
    emit: (event: unknown, envelope = "stream.event") => {
      const body = envelope === "stream.event" ? { type: "stream.event", payload: event } : event
      sink!.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`))
    },
  }
}

const chat = (server: ReturnType<typeof control>, handlers: { onBack: () => void; onQuit: () => void }, t: Parameters<typeof mount>[1], agent: { agentId?: string; agentName?: string } = { agentId: "niri" }): Screen =>
  mount(createElement(ChatScreen, { baseUrl: "https://control.test", ...agent, fetchImpl: server.fetchImpl, settleMs: 20, ...handlers }), t)

test("the chat renders echoes, thinking, streamed text, tool lines and usage", async (t) => {
  const server = control()
  const screen = chat(server, { onBack: () => {}, onQuit: () => {} }, t)
  await screen.shows("tips: /v toggle tool output")
  await screen.shows("niri is awake")
  await server.ready()
  server.emit({ type: "user", text: "hey", source: "discord", triggeredAt: "now", clientId: "other-client" })
  await screen.shows("discord:")
  await screen.shows("hey")
  server.emit({ type: "thinking", text: "weighing options" })
  await screen.shows("\u27e8 thinking \u27e9")
  assert.equal(screen.all().includes("weighing options"), false, "thinking stays hidden until /t")
  server.emit({ type: "text", text: "hello" })
  await until(() => screen.last().includes("niri: hello"), "streamed text")
  server.state.idle = true
  // A settled reply is a transcript record: the next chunk opens its own line.
  await new Promise((resolve) => { setTimeout(resolve, 150) })
  server.emit({ type: "text", text: "world" })
  await until(() => screen.last().includes("niri: world"), "a second reply")
  assert.equal(screen.last().includes("niri: hello"), true)
  assert.equal(screen.last().includes("helloworld"), false)
  server.emit({ type: "tool", name: "shell", args: { command: "ls" }, result: "one\ntwo" })
  await screen.shows("tool: $ ls")
  await screen.shows("\u2026 2 lines hidden \u00b7 /v to expand")
  server.emit({ type: "usage", completionTokens: 3, elapsedMs: 1000 })
  await screen.shows("stats: 3 out \u00b7 1.0s")
  server.emit({ type: "text", text: "half a th" })
  await until(() => screen.last().includes("half a th"), "a turn in progress")
  server.emit({ type: "error", text: "401 Incorrect API key" })
  await screen.shows("401 Incorrect API key")
  const frame = screen.last()
  // The half-written turn is kept as what was said, with the failure under it.
  assert.ok(frame.indexOf("half a th") < frame.indexOf("401 Incorrect API key"), frame)
})

test("a replayed reply is shown, and the record of a reply we watched stream is not repeated", async (t) => {
  const server = control()
  const screen = chat(server, { onBack: () => {}, onQuit: () => {} }, t)
  await server.ready()
  server.emit({ type: "conversation.message", payload: { role: "assistant", content: "hi from the log" } }, "conversation.message")
  await screen.shows("niri: hi from the log")
  server.emit({ type: "text", text: "live words" })
  await until(() => screen.last().includes("live words"), "streamed reply")
  server.emit({ type: "conversation.message", payload: { role: "assistant", content: "live words" } }, "conversation.message")
  await tick(); await tick()
  assert.equal(screen.last().split("live words").length - 1, 1, "the record settles the stream instead of repeating it")
})

test("chat commands leave, quit, report status and toggle tool and thinking output", async (t) => {
  const server = control()
  let back = 0; let quit = 0
  const screen = chat(server, { onBack: () => { back++ }, onQuit: () => { quit++ } }, t)
  await server.ready()
  server.state.running = false
  await screen.press("/status"); await screen.press("\r")
  await screen.shows("niri is sleeping")
  server.emit({ type: "tool", name: "read_file", args: { path: "hidden.md" }, result: "output kept back" })
  await screen.shows("\u2026 1 lines hidden \u00b7 /v to expand")
  assert.equal(screen.all().includes("output kept back"), false)
  await screen.press("/v"); await screen.press("\r")
  await screen.shows("tool output: expanded")
  // /v rewrites the line it hid; it does not print the tool a second time.
  await until(() => screen.last().includes("output kept back"), "the hidden body expands in place")
  assert.equal(screen.last().includes("lines hidden"), false)
  assert.equal(screen.last().split("tool: read hidden.md").length - 1, 1)
  server.emit({ type: "tool", name: "read_file", args: { path: "notes.md" }, result: "body line" })
  await screen.shows("tool: read notes.md")
  await screen.shows("body line")
  server.emit({ type: "thinking", text: "out loud" })
  server.emit({ type: "tool", name: "rest", args: {}, result: "settled" })
  await until(() => screen.last().includes("\u27e8 thinking \u27e9"), "a hidden thought")
  assert.equal(screen.last().includes("out loud"), false)
  await screen.press("/t"); await screen.press("\r")
  await screen.shows("thinking traces: visible")
  // /t reveals the same thought where it already is.
  await until(() => screen.last().includes("\u27e8 thinking \u27e9 out loud"), "the thought expands in place")
  assert.equal(screen.last().split("\u27e8 thinking \u27e9").length - 1, 1)
  await screen.press("/a"); await screen.press("\r")
  await until(() => back === 1, "returned to the agents view")
  await screen.press("/q"); await screen.press("\r")
  await until(() => quit === 1, "quit")
})

test("the left arrow leaves only when the composer is empty", async (t) => {
  const server = control()
  let back = 0
  const screen = chat(server, { onBack: () => { back++ }, onQuit: () => {} }, t)
  await server.ready()
  await screen.press("draft text")
  await until(() => screen.last().includes("draft text"), "typed message")
  await screen.press("\u001b[D")
  assert.equal(back, 0)
  assert.equal(screen.last().includes("draft text"), true)
  await screen.press("\u0015")
  await until(() => !screen.last().includes("draft text"), "ctrl-u cleared the composer")
  await screen.press("\u001b[D")
  await until(() => back === 1, "left arrow left the chat")
})

test("a sent message is posted with our client id and echoed once", async (t) => {
  const server = control()
  const screen = chat(server, { onBack: () => {}, onQuit: () => {} }, t)
  await server.ready()
  await screen.press("hi there"); await screen.press("\r")
  await until(() => server.posts.length === 1, "message posted")
  assert.equal(server.posts[0]!.url, "https://control.test/agents/niri/events")
  assert.equal(server.posts[0]!.body.content, "hi there")
  const clientId = String(server.posts[0]!.body.clientId)
  assert.match(clientId, /^cli-/)
  await screen.shows("you:")
  server.emit({ type: "user", text: "hi there", source: "you", triggeredAt: "now", clientId })
  server.emit({ type: "user", text: "and from elsewhere", source: "discord", triggeredAt: "now", clientId: "other-client" })
  await screen.shows("and from elsewhere")
  assert.equal(screen.last().split("hi there").length - 1, 1, "our own echo is not printed twice")
})

test("the root app moves from the list into a chat, back again, and quits", async (t) => {
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { sink = controller } }), { status: 200 })
    if (url.endsWith("/status")) return json({ running: true, idle: false })
    if (url.endsWith("/agents")) return json({ agents: [{ id: "alpha", name: "alpha the first", status: "running" }] })
    return json({ ok: true })
  }
  const client = new NiriClient({ baseUrl: "https://control.test", fetchImpl })
  const screen = mount(createElement(RootApp, { client, fetchImpl }), t)
  await screen.shows("alpha the first")
  await screen.press("\r")
  await screen.shows("tips: /v toggle tool output")
  // The list knows the agent's name; the chat it opens speaks in it.
  await screen.shows("alpha the first is awake")
  await until(() => sink !== undefined, "chat stream subscription")
  await screen.press("/a"); await screen.press("\r")
  await until(() => screen.last().includes("enter chat"), "back on the agents view")
  const stacked = screen.raw().length
  await screen.press("\r")
  await screen.shows("tips: /v toggle tool output")
  await screen.press("/a"); await screen.press("\r")
  await until(() => screen.last().includes("enter chat"), "back on the agents view again")
  assert.ok(screen.raw().slice(stacked).includes("\u001b[2J"), "the list clears what the chat left on screen")
  await screen.press("q")
  await screen.app.waitUntilExit()
})

test("a chat with a stopped agent reports it once, with the command that fixes it", async (t) => {
  const missing: typeof fetch = async () => json({ error: "agent not found" }, 404)
  let back = 0
  const screen = mount(createElement(ChatScreen, { baseUrl: "https://control.test", agentId: "nova", fetchImpl: missing, onBack: () => { back++ }, onQuit: () => {} }), t)
  await screen.shows("agent nova is not running \u2014 start it with `niri agents start nova`")
  await until(() => screen.all().split("is not running").length === 2, "one report, not one per request")
  assert.equal(back, 0)
})

test("ctrl-c cancels a draft back to the list, and ends the session from the list or a chat", async (t) => {
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined
  const posts: Post[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { sink = controller } }), { status: 200 })
    if (url.endsWith("/status")) return json({ running: true, idle: false })
    if (url.endsWith("/agents") && init?.body) { posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ id: "x", config: {} }) }
    return json({ agents: [{ id: "alpha", status: "running" }] })
  }
  const client = new NiriClient({ baseUrl: "https://control.test", fetchImpl })
  const alive = async (screen: Screen): Promise<boolean> =>
    await Promise.race([screen.app.waitUntilExit().then(() => false), tick().then(() => tick()).then(() => true)])

  const drafting = mount(createElement(RootApp, { client, fetchImpl }), t)
  await drafting.shows("alpha")
  await drafting.press("c")
  await drafting.shows("new agent id:")
  await drafting.press("dra")
  await drafting.press("\u0003")
  await until(() => drafting.last().includes("enter chat"), "back on the list")
  assert.equal(await alive(drafting), true, "the app survives a cancelled draft")
  assert.deepEqual(posts, [], "a cancelled draft creates nothing")
  await drafting.press("\u0003")
  await drafting.app.waitUntilExit()

  const chatting = mount(createElement(RootApp, { client, fetchImpl }), t)
  await chatting.shows("alpha")
  await chatting.press("\r")
  await chatting.shows("tips: /v toggle tool output")
  await until(() => sink !== undefined, "chat stream subscription")
  await chatting.press("\u0003")
  await chatting.app.waitUntilExit()
})

test("the chat speaks in the agent's own name", async (t) => {
  const server = control()
  const named = chat(server, { onBack: () => {}, onQuit: () => {} }, t, { agentId: "rin", agentName: "rin the second" })
  await named.shows("rin the second is awake")
  await server.ready()
  server.emit({ type: "text", text: "hello" })
  await until(() => named.last().includes("rin the second: hello"), "the agent's name prefixes its reply")
  assert.equal(named.all().includes("niri:"), false)

  const server2 = control()
  const byId = chat(server2, { onBack: () => {}, onQuit: () => {} }, t, { agentId: "lyra" })
  await byId.shows("lyra is awake")
  server2.state.running = false
  await byId.press("/status"); await byId.press("\r")
  await byId.shows("lyra is sleeping — your message will wake them")
})

test("the live window is bounded: what no longer fits becomes printed history", async (t) => {
  const server = control()
  const screen = chat(server, { onBack: () => {}, onQuit: () => {} }, t)
  await server.ready()
  for (let index = 0; index < 40; index++) {
    server.emit({ type: "user", text: `line ${index}`, source: "discord", triggeredAt: "now", clientId: "other-client" })
  }
  await screen.shows("line 39")
  // A keystroke repaints the live window alone, with no fresh history in the frame.
  await screen.press("x")
  const frame = screen.last().split("\n").filter((line) => line.length)
  assert.ok(frame.length <= 24, `the frame must fit 24 rows, got ${frame.length}`)
  assert.ok(frame.some((line) => line.includes("line 39")), "the newest record stays live")
  assert.equal(frame.some((line) => line.includes("line 0")), false, "the oldest scrolled out")
  assert.ok(screen.all().includes("line 0"), "and was printed on its way out")
})
