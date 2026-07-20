# Niri architecture

## The mental model

**niri is a harness.** It reads `agents/*.yaml` and **spawns one agent process per agent**. Each agent process *is* the agent — its model loop, memory, soul, and Discord connection. Each agent operates one **box**: the place its tools run.

```
niri harness
  └─ spawns one agent process per agent
       └─ each agent talks to one box (tool client)
```

A **box** is the tool-execution boundary — where `shell`, `read_file`, `edit_file`, `image_tool`, and `read_blob` actually run. Three forms:

- **the same server** (`client: local`) — tools run inside the agent's own process
- **another machine** (`client: http://…` or `client: iroh`) — a tool client on your laptop or any other host
- **a docker container** — not a separate location, but an *execution backend inside the tool client*: wherever the client runs (including the harness host), it can run shell commands inside a container instead of directly on the host

Example live setup: the harness on a server spawns `lyra` and `mira`; mira's box is the server itself, lyra's box is a laptop on the LAN connected over iroh.

Agents can also live off the harness host: `worker.mode: remote` makes the harness wait for the agent process to **dial in** over iroh instead of spawning it. Same model — the agent process just boots somewhere else.

---

## Implementation details

### Control plane (`apps/server`)

One process. Spawns and supervises the agent processes (health checks, restarts), keeps the agent registry in `data/control/control.db`, mirrors agent events for the web UI, verifies webhook signatures, and runs the iroh acceptor. It never talks to a model; it only coordinates.

### Agent process (`packages/niri-runtime`)

One process per agent — the agent itself. Owns:

- the **model loop**: turns, tools, compaction (LCM summaries with provenance)
- **memory and soul**: `<home>/memories/`, `<home>/soul.md`, the `niri.db` search index
- **Discord**: gateway connection, inbox, batching, cooldowns
- **triggers**: cron heartbeat, `schedule` reminders, bsky, webhooks, chat
- **MCP servers** and the codex/antigravity bridges
- its **box link**: how it reaches the tool client

Everything durable about the agent lives in its home directory (`soul.md`, `memories/`, `state/`, `niri.db`, `metrics.db`).

### Tool client (`apps/client`, `packages/harness-client-node`)

The box. Answers tool calls from its agent; never initiates anything. Runs `shell`, `read_file`, `edit_file`, `image_tool`, and the internal `read_blob` (chunked, hash-verified binary reads used for Discord attachments). With the docker execution backend enabled, shell commands run inside a container rather than on the client host.

### How an agent reaches its box

| `client:` in the agent yaml | how it connects | when to use |
| --- | --- | --- |
| `local` | in-process, no socket | the agent operates the harness host itself |
| `http://host:port` | the box listens; the agent dials it | trusted networks only — unauthenticated plain HTTP |
| `iroh` | the box **dials out** to the control plane; the agent talks to a loopback tunnel port | the default for real machines — NAT-proof, encrypted, token-authenticated |

With `client: iroh`, the control plane keeps an always-on loopback tunnel for the agent (`127.0.0.1:<port>` on the harness host). When the box dials in and proves the shared token, its connection is attached to that tunnel. Until then the agent sees an unreachable box, exactly like a powered-off machine. `client: iroh` requires a local agent process — the tunnel lives on the harness host's loopback, which a remote agent process cannot reach (a remote agent should use a box on its own machine or a URL it can reach).

### iroh, the shared transport

The control plane binds one iroh endpoint (QUIC with NAT traversal) and accepts two dial-in roles over the same ticket + token:

- `role: "client"` — a tool client (box) dialing out. The control plane attaches the connection to that agent's pre-created tunnel.
- `role: "worker"` — a remote agent process. The control plane exposes the connection as a loopback tunnel; all control traffic (status, events/SSE, triggers) is ordinary HTTP over it.

Tunnels are raw byte pipes: each accepted loopback TCP socket opens one QUIC BiStream, pumped end to end. Handshakes carry `{role, agentId, instanceId, token}` and are acked only after registration completes, so a connected peer is immediately usable. Reconnects replace connections identity-safely; disconnects remove registrations and drain sockets so nothing routes to a stale or replaced peer. Identity files: `data/control/iroh.secret` (endpoint) and `data/control/iroh.token` (shared dial-in token, printed once on first boot).

### Turn flow

1. A trigger arrives: discord gateway event, cron heartbeat, a fired `schedule` reminder, bsky, webhook, chat, or the control API.
2. The agent process wakes (or enqueues into its running session), builds context (bootstrap + LCM summaries + passive memory recall), and runs model turns.
3. The model calls exactly one tool per turn: memory/soul tools, discord tools, box tools, MCP tools, `schedule`, or loop control (`wait`, `wait_then_continue`, `rest`).
4. Events stream to the agent's outbox (`worker_events` in `niri.db`), mirrored by the control plane for the UI.
5. `rest` ends the session with a durable snapshot; the next trigger starts a fresh one with a rest summary.
