# Niri architecture

## The mental model

**niri runs agents.** The niri server reads `agents/*.yaml` and starts one **agent runtime** for each configured agent. Each runtime is the agent's living process: it owns the model loop, memory, soul, Discord connection, and triggers. Each agent is attached to one **tool host**, where shell and file operations run.

```
niri server
  ├─ agent: mira
  │    ├─ home: durable memory and state
  │    └─ tool host: mira's macbook
  └─ agent: nova
       ├─ home: durable memory and state
       └─ tool host: embedded
```

The three canonical component names are:

- **niri server** — the central process that configures, supervises, and routes to agents
- **agent runtime**, or **agent** in ordinary prose — one process containing one agent's mind and durable state
- **tool host** — the execution boundary for `shell`, `read_file`, `edit_file`, `image_tool`, and `read_blob`

Keep these independent from placement and transport:

- An agent is **managed** when the niri server starts and supervises it, or **standalone** when it starts elsewhere and dials in. The current YAML values are `worker.mode: local` and `worker.mode: remote`.
- A tool host is **embedded** when it runs inside the agent runtime (`client: local`), or separate when reached through HTTP or iroh.
- A separate tool host may run on the niri server machine or another machine.
- Docker is an **execution backend** inside a tool host, not another kind of connection or component.

Example live setup: the niri server starts the managed agents `lyra` and `mira`. Mira uses an embedded tool host. Lyra's tool host runs on a laptop and connects over iroh. A standalone agent would have the same internal responsibilities; only its placement and supervision differ.

---

## Implementation details

### Niri server (`apps/server`)

One process. Starts and supervises managed agents (health checks, restarts), keeps the agent registry in `data/control/control.db`, mirrors agent events for the web UI, verifies webhook signatures, and runs the iroh acceptor. It never talks to a model; it only coordinates.

### Agent runtime (`packages/niri-runtime`)

One process per agent — the agent itself. Owns:

- the **model loop**: turns, tools, compaction (LCM summaries with provenance)
- **memory and soul**: `<home>/memories/`, `<home>/soul.md`, the `niri.db` search index
- **Discord**: gateway connection, inbox, batching, cooldowns
- **triggers**: cron heartbeat, `schedule` reminders, bsky, webhooks, chat
- **MCP servers** and the codex/antigravity bridges
- its **tool-host link**: how it reaches the tool host

Everything durable about the agent lives in its home directory (`soul.md`, `memories/`, `state/`, `niri.db`, `metrics.db`).

### Tool host (`apps/client`, `packages/harness-client-node`)

Answers tool calls from its agent; it never initiates agent work. In iroh mode it does initiate the transport connection by dialing the niri server, but its component role remains the tool host. It runs `shell`, `read_file`, `edit_file`, `image_tool`, and the internal `read_blob` (chunked, hash-verified binary reads used for Discord attachments). With the Docker execution backend enabled, shell commands run inside a container rather than directly on the tool-host machine.

### How an agent reaches its tool host

The YAML field is still named `client` for compatibility. Its value selects the tool-host connection:

| `client:` in the agent YAML | how it connects | when to use |
| --- | --- | --- |
| `local` | embedded in the agent runtime; no socket | the agent operates the same machine as its runtime |
| `http://host:port` | the tool host listens; the agent dials it | trusted networks only — unauthenticated plain HTTP |
| `iroh` | the tool host dials the niri server; the agent talks to a loopback tunnel port | the default for separate machines — NAT-proof, encrypted, token-authenticated |

With `client: iroh`, the niri server keeps an always-on loopback tunnel for the agent (`127.0.0.1:<port>` on the server machine). When the tool host dials in and proves the shared token, its connection is attached to that tunnel. Until then, tool calls are unavailable. This mode requires a managed agent because the tunnel lives on the niri server machine's loopback; a standalone agent should use an embedded tool host or an HTTP URL it can reach.

### iroh, the shared transport

The niri server binds one iroh endpoint (QUIC with NAT traversal) and accepts two dial-in roles over the same ticket and token. The wire protocol retains its original role names for compatibility:

- `role: "client"` — a tool host dialing out. The niri server attaches the connection to that agent's pre-created tunnel.
- `role: "worker"` — a standalone agent dialing out. The niri server exposes the connection as a loopback tunnel; all agent traffic (status, events/SSE, triggers) is ordinary HTTP over it.

Tunnels are raw byte pipes: each accepted loopback TCP socket opens one QUIC BiStream, pumped end to end. Handshakes carry `{role, agentId, instanceId, token}` and are acked only after registration completes, so a connected peer is immediately usable. Reconnects replace connections identity-safely; disconnects remove registrations and drain sockets so nothing routes to a stale or replaced peer. Identity files: `data/control/iroh.secret` (endpoint) and `data/control/iroh.token` (shared dial-in token, printed once on first boot).

### Turn flow

1. A trigger arrives: discord gateway event, cron heartbeat, a fired `schedule` reminder, bsky, webhook, chat, or the control API.
2. The agent runtime wakes (or enqueues into its running session), builds context (bootstrap + LCM summaries + passive memory recall), and runs model turns.
3. The model calls exactly one tool per turn: memory/soul tools, Discord tools, tool-host tools, MCP tools, `schedule`, or loop control (`wait`, `wait_then_continue`, `rest`).
4. Events stream to the agent's outbox (`worker_events` in `niri.db`, retaining its compatibility-era table name), mirrored by the niri server for the UI.
5. `rest` ends the session with a durable snapshot; the next trigger starts a fresh one with a rest summary.
