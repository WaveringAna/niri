# Niri architecture

## The mental model

**niri runs agents.** The niri server reads `agents/*.yaml` and starts one **agent runtime** for each configured agent. Each runtime is the agent's living process: it owns the model loop, memory, soul, Discord connection, and triggers. Each agent is attached to one **tool host**, where shell and file operations run.

```
one niri machine
  └─ niri server
       ├─ agent 1 ─ tool host 1 ─ sandbox 1
       ├─ agent 2 ─ tool host 2 ─ sandbox 2
       ├─ agent 3 ─ tool host 3 ─ sandbox 3
       ├─ agent 4 ─ tool host 4 ─ sandbox 4
       └─ agent 5 ─ tool host 5 ─ sandbox 5
```

This is the recommended topology: one niri server manages several agent runtimes, while every agent keeps its own durable home and dedicated tool environment. The agents can all run on the server machine; each tool host can live in a disposable microVM, a persistent VM, a container, or a dedicated physical machine according to that agent's isolation and persistence needs.

Niri enforces unique agent homes and gives each agent one configured tool-host connection. It does not provision sandboxes or treat `workspace` as a filesystem security boundary: an embedded host tool can still reach paths outside its starting directory. Isolation and persistence belong to the environment where the user runs that agent's tool host.

The three canonical component names are:

- **niri server** — the central process that configures, supervises, and routes to agents
- **agent runtime**, or **agent** in ordinary prose — one process containing one agent's mind and durable state
- **tool host** — the execution boundary for persistent `python`, `shell`, `read_file`, `edit_file`, `image_tool`, and `read_blob`

Keep these independent from placement and transport:

- An agent is **managed** when the niri server starts and supervises it, or **standalone** when it starts elsewhere and dials in. The current YAML values are `worker.mode: local` and `worker.mode: remote`.
- A tool host is **embedded** when it runs inside the agent runtime (`client: local`), or separate when reached through HTTP or iroh.
- A separate tool host may run on the niri server machine or another machine.
- A microVM, VM, container, or physical machine is the tool host's **execution environment**, not another niri component.

For example, the niri server may start the managed agents `lyra` and `mira`. Mira's tool host can run in a disposable microVM, while Lyra's can run on a persistent laptop and connect over iroh. A standalone agent has the same internal responsibilities; only its placement and supervision differ.

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

Answers tool calls from its agent; it never initiates agent work. In iroh mode it does initiate the transport connection by dialing the niri server, but its component role remains the tool host. It runs persistent `python`, `shell`, `read_file`, `edit_file`, `image_tool`, and the internal `read_blob` (chunked, hash-verified binary reads used for Discord attachments). With the Docker execution backend enabled, shell commands run inside a container rather than directly on the tool-host machine.

### Persistent Python and host RPC

`python` is a process-owned kernel on the tool-host side. It starts when the tool host starts and is advertised only after a readiness handshake succeeds (Python >= 3.9). Its namespace, imports, helper functions, and current directory persist across ordinary model turns. A cell that reaches its invocation deadline receives `SIGINT`; when Python acknowledges the interrupt within two seconds, the cell is cancelled and the namespace remains intact. A cell that ignores `SIGINT` is force-killed after that grace period and the kernel restarts. `rest`, an explicit reset, tool-host shutdown, or that forced restart clears the namespace. It is scratch state, not durable agent state and not a sandbox.

The kernel starts in the user's workspace, but Python bytecode from both cells and commands launched through `sh` is redirected to `$CLIENT_HOME/.cache/niri-python` through `PYTHONPYCACHEPREFIX`. `niri.scratch` names a writable directory at `$CLIENT_HOME/.cache/niri-scratch`, outside the workspace; it survives namespace resets and is the place for temporary generated files that should not enter the user's tree.

Kernel control messages travel on dedicated file descriptors (3 and 4), never on the interpreter's stdin/stdout/stderr. Stdin is closed (`input()` raises immediately). Cell stdout/stderr flow through the normal fds and are drained continuously; the kernel writes an end marker after flushing, so subprocess output cannot corrupt the control channel. That marker is minted per cell from random bytes, so cell output cannot forge a boundary and misattribute the rest of its own output to the next cell.

The model-facing result remains capped at 512,000 bytes. Independently, the tool host archives up to 8 MiB from each completed cell, retaining the newest 32 archives within a 32 MiB process-wide cap. The synchronous `out.list()`, `out.size()`, `out.page()`, `out.tail()`, and `out.grep()` helpers inspect any retained archive by id without rerunning the computation. Archives survive intervening cells, explicit namespace resets, and forced Python restarts; tool-host shutdown clears them.

Resets are ordinary kernel operations rather than fire-and-forget writes: an explicit reset is serialized behind whatever cell is running and resolves only when Python acknowledges it, so a caller that awaits a session-boundary reset knows the namespace is actually gone.

When the attached host advertises `python`, niri exposes `python` and `image_tool` as the model-facing workspace interface by default. The older `shell`, `read_file`, `write_file`, `edit_file`, and `read_blob` capabilities remain implemented for transport compatibility and can be temporarily restored to the model catalog with `NIRI_LEGACY_WORKSPACE_TOOLS=true`.

The kernel preloads `read`, `edit`, `sh`, `glob`, `grep`, and `out`. `read(..., hashline=True)` prefixes each selected source line with the same `<line>#<hash>` anchors used by memory and soul reads; `edit(path, target, content)` replaces or deletes one anchored line or inclusive range, relocating a stale line number when its hash remains unique. `glob(...)` and `grep(...)` provide bounded workspace-native discovery without a shell round trip. The file, edit, and shell helpers call the same bounded Node implementations as the compatibility tools. `sh` returns a structured `ShellResult` whose compact representation reports metadata while retaining command output for explicit `.page()`, `.tail()`, or `.grep()` inspection; long commands are resumable via `sh.poll(session_id)` and `sh.terminate(session_id)`. It also preloads the `niri` client. `niri.whoami()` and `niri.deadline()` synchronously expose the current agent, paths, invocation, host-RPC availability, and remaining time. Calls such as `await niri.memory.search(...)` send typed `HostRpcRequest` values back to the agent runtime, while `await niri.budget()` combines the loop's token and context counters with the local deadline. Memory, soul, context, Discord state, schedules, and loop accounting remain authoritative TypeScript services in the runtime.

Every outer Python invocation receives an opaque execution grant bound to its invocation id and deadline. The runtime revokes it when the outer invocation completes. A stale background task therefore cannot retain host privileges, even though model-generated Python still has the tool host's ordinary OS permissions. The RPC deadline bounds the wait and the grant; it does not abort an already-running service operation. Host RPC does not expose Python, shell, files, images, wait, or rest, which prevents the nested request from looping back into the occupied tool executor or agent-loop control flow.

Direct deployments use ordinary HTTP for the reverse request. With iroh, the outer runtime-to-client request uses a server-opened QUIC BiStream while nested client-to-runtime RPC uses an independent client-opened BiStream. Both carry plain HTTP. The accept loops launch pumps concurrently, so the runtime can service the nested request while it is still awaiting the outer Python result.

An authenticated client connection is authority to invoke its agent's host RPC, not HTTP reach into that agent's runtime. Client-opened streams are therefore pumped into a per-connection loopback ingress on the control plane that admits `POST /host-rpc` and nothing else: any other method is refused with 405, any other path with 404, and an oversized body with 413, none of which ever reach the runtime. The ingress resolves the target from the dial-in identity on every request, so the route follows the agent's current runtime and can never be steered by request contents. The runtime's own `/host-rpc` still validates the execution grant behind it.

The service methods reachable over host RPC are the same typed operations the model-facing tool adapters call. Each RPC-exposed method has exactly one implementation that owns its validation, coercion, and result shape, so a method cannot mean one thing to the model and another to model-generated Python. Service failures carry stable wire codes. Python preserves the message and raises `NiriError` or the corresponding `NiriInvalid`, `NiriNotFound`, `NiriUnauthorized`, `NiriDeadlineExceeded`, or `NiriUnavailable` subclass, allowing cells to branch without matching error prose.

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
3. Tool choice is automatic. The model may call memory/soul tools, Discord tools, tool-host tools, MCP tools, `schedule`, or loop control (`wait`, `wait_then_continue`, `rest`). A response with no tool call is treated as an inferred ten-minute `wait_then_continue`; an incoming event wakes it early.
4. Events stream to the agent's outbox (`worker_events` in `niri.db`, retaining its compatibility-era table name), mirrored by the niri server for the UI.
5. `rest` ends the session with a durable snapshot; the next trigger starts a fresh one with a rest summary.

Compaction is the only point where active history is mechanically rewritten. Once the observed prompt crosses the compaction trigger, the runtime first archives and bounds large old non-social tool results while preserving the recent tail and memory/Discord/context tool traffic; ordinary turns never perform that rewrite, preserving provider prompt-cache stability. LLM summaries remain provenance-backed. A provider/model circuit breaker suppresses repeated summary calls after billing, authentication, transport, or unusable-output failures, with permanent process-lifetime disablement for non-retryable provider errors and bounded cooldowns for transient failures.

### Delegated tasks and Gastown

Delegated task workers are not full agent runtimes. Niri remains the sole persistent persona; each worker receives a fresh task-only conversation, one configured profile prompt, bounded durable feedback from Niri for that profile, an optional profile-specific model, and explicit allowlists of attached-client and namespaced MCP tools. Workers do not inherit tools implicitly. Worker transcripts and mailbox messages live in `delegated_tasks` and `delegated_task_messages`; Niri's worker-profile guidance lives in `delegation_profile_feedback`. All three are inside the agent's `niri.db`, outside the main conversation and LCM frontier.

`delegate spawn` returns immediately. The runtime executes queued workers with a concurrency bound and a single-writer lease. Deliberate `task_message` progress updates, blocking questions, and bounded final results enter the main agent's event stream; ordinary worker tool traffic stays outside her active context. Runtime restarts mark in-flight work interrupted rather than silently losing its apparent state.

`delegate feedback` is the workers' intentionally narrow memory system. Niri can record guidance against any task, including a completed one. Active workers receive it through their mailbox; future instances of the same profile receive a bounded chronological feedback stack in their initial system prompt.

When `discord.gastownForumChannelId` is configured, the runtime creates one Discord forum thread per task. Discord mirrors the durable mailbox and accepts multiplayer steering from every human able to write in that private thread; it is not the source of truth and has no per-user or per-role ACL layer. Bot and webhook messages are excluded only to prevent feedback loops.
