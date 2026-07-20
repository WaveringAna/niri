# Niri architecture

Niri runs long-lived personal agents. Each agent has a soul (`soul.md`), a Markdown long-term memory, a Discord presence, and a set of tools. The system is split into three kinds of processes so the heavy/unsafe parts can live on different machines.

## Processes

```
                ┌─────────────────────────────────────────────────┐
                │ control plane  (apps/server)                    │
                │  - supervisor: spawns local agent workers       │
                │  - control REST API + SSE + web UI              │
                │  - webhook ingress (HMAC)                       │
                │  - iroh acceptor (remote workers + tool clients)│
                └───────▲───────────────────────▲─────────────────┘
        loopback HTTP   │                       │   iroh (QUIC, NAT-traversing)
   or iroh tunnel       │                       │   dial-out + token handshake
                ┌───────┴────────┐      ┌───────┴────────┐
                │ agent worker   │      │ tool client    │
                │ (niri-runtime) │      │ (apps/client)  │
                │  - agent loop  │      │  - shell       │
                │  - memory/soul │      │  - read_file   │
                │  - discord gw  │      │  - edit_file   │
                │  - MCP, bridges│      │  - image_tool  │
                │  - scheduler   │      │  - read_blob   │
                └───────▲────────┘      └────────────────┘
                        │  HTTP tool calls (loopback or iroh tunnel)
                        └────────────────────────────────
```

### Control plane (`apps/server`)

One process. Loads `agents/*.yaml`, spawns a worker per `worker.mode: local` agent (via the supervisor, with health checks and restarts), and exposes the control API (`/agents/*`, `/ui`, webhooks). Worker registrations live in a SQLite control DB (`data/control/control.db`), which also mirrors worker events for the UI.

### Agent worker (`packages/niri-runtime`)

One process per agent. Owns everything identity-shaped: the model loop, compaction (LCM summaries with provenance), memory (`<home>/memories/` + `niri.db` FTS/vector index), `soul.md`, the Discord gateway connection, MCP servers, the codex/antigravity bridges, and the schedule dispatcher. The worker listens on loopback HTTP (`/awp/*`, `/trigger/*`, `/discord/*`, `/metrics*`); the control plane talks to it there (or over an iroh tunnel for remote workers).

### Tool client (`apps/client`, `packages/harness-client-node`)

Runs on any machine the agent should touch. Executes `shell`, `read_file`, `edit_file`, `image_tool`, and the internal `read_blob` (chunked, hash-verified binary reads used for Discord attachments). The **worker** initiates tool calls; the client only answers them.

## Links

### Control plane ↔ worker

- **Local workers** (default): supervisor spawns the worker on the same host; control plane reaches it on `http://127.0.0.1:<port>`.
- **Remote workers** (`worker.mode: remote` + worker-side `server.iroh.{ticket,token}`): the worker dials the control plane's iroh endpoint. The acceptor verifies a token handshake, then exposes the connection as a loopback TCP tunnel (one BiStream per socket, pumped to the worker's loopback Fastify). The control plane keeps using plain HTTP — including SSE — through the tunnel. Disconnects remove the registration so nothing routes to a stale port.

### Worker ↔ tool client

The worker calls the client over HTTP (`NIRI_CLIENT`):

- **`client: local`** — in-process `NodeToolHost`, no socket at all.
- **`client: http://host:port`** — the client listens; the worker dials it. Simple, but needs the client machine to be reachable (open port, routable address) and the traffic is unauthenticated HTTP — keep it to trusted networks.
- **`client: iroh`** — the client dials **out** to the control plane with the same ticket/token handshake (`role: "client"`). The control plane keeps an always-on loopback tunnel at a deterministic port per agent and attaches the client's connection when it arrives; the worker's `NIRI_CLIENT` simply points at that loopback port. Until the client connects, the worker sees an unreachable endpoint — identical to an offline client box. This is the NAT-proof, encrypted, token-authenticated path and the recommended way to run a client on a laptop or another network. Requires a **local worker** (`worker.mode: local`): the tunnel lives on the control-plane host's loopback, which a remote worker cannot reach.

Both iroh links share one acceptor on the control plane (ALPN `niri/awp/0`), one endpoint identity (`data/control/iroh.secret`), and one dial-in token (`data/control/iroh.token`). The handshake distinguishes `role: "worker"` from `role: "client"`; the success ack is sent only after registration completes, so a connected peer is immediately usable.

## Agent home

Everything durable about an agent lives in its home directory (server-side for managed workers):

| Path | Contents |
| --- | --- |
| `soul.md` | the agent's self-authored identity |
| `memories/` | long-term Markdown memories (core notes, journals, people) |
| `state/` | session snapshots, rest snapshots, iroh identity |
| `niri.db` | memory index, discord store, schedules, worker events |
| `metrics.db` | token usage, latencies, compaction metrics |

## Turn flow

1. A trigger arrives: discord gateway event, cron heartbeat, a fired `schedule` reminder, bsky, webhook, chat, or the control API.
2. The worker's loop wakes (or enqueues into the running session), builds context (bootstrap + LCM summaries + passive memory recall), and runs model turns.
3. The model calls exactly one tool per turn: memory/soul tools, discord tools, client tools, MCP tools, `schedule`, or loop control (`wait`, `wait_then_continue`, `rest`).
4. Events stream to the outbox (`worker_events` in `niri.db`), mirrored by the control plane for the UI.
5. `rest` ends the session with a durable snapshot; the next trigger starts a fresh one with a rest summary.
