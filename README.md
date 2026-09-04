# Niri

**niri runs agents.** The niri server reads `agents/*.yaml` and starts one agent runtime for each configured agent. Each agent runtime owns the agent's model loop, memory, soul, Discord connection, and triggers. Shell and file operations run through the agent's attached **tool host**, which may be embedded in the runtime or connected as a separate process.

System architecture: [docs/architecture.md](docs/architecture.md)

## Run the server

```sh
npm ci
cp agents/mira.example.yaml agents/mira.yaml
chmod 600 agents/mira.yaml
# edit agents/mira.yaml
npm start
```

The niri server reads every `.yaml` and `.yml` file in `agents/`. Files ending in `.example.yaml` or `.example.yml` are skipped.

## Run a tool host

```sh
npm run start:tool-host
```

The tool host listens on `0.0.0.0:3002` and runs `shell`, `read_file`, `write_file`, `edit_file`, and `image_tool` from its workspace root. It also exposes a chunked `read_blob` operation, which the agent runtime uses internally to attach tool-host files to Discord messages.

## Recommended topology

The normal setup is one niri server managing several agents. Each agent has its own durable home and should have its own tool sandbox:

```text
one niri machine
  └─ niri server
       ├─ agent 1 ─ tool host 1 ─ sandbox 1
       ├─ agent 2 ─ tool host 2 ─ sandbox 2
       ├─ agent 3 ─ tool host 3 ─ sandbox 3
       ├─ agent 4 ─ tool host 4 ─ sandbox 4
       └─ agent 5 ─ tool host 5 ─ sandbox 5
```

All five managed agent runtimes may run on the niri server machine. Each agent's tool host lives in a user-provided environment chosen for that agent's isolation and persistence needs: a disposable microVM, a persistent VM, a container, or a dedicated physical machine. Niri enforces a unique durable `home` for every agent, but it does not provision these sandboxes, and `workspace` is only an initial working directory rather than a filesystem security boundary.

## Remote tool hosts over iroh

The same transport works for tool hosts — this is how a laptop or another machine connects without listening on a public port. The YAML field is still named `client` for compatibility; set it to `iroh`:

```yaml
client: iroh
```

The niri server then keeps an always-on loopback tunnel for that agent and points the agent runtime at it. Until the tool host dials in, tool calls are unavailable. `client: iroh` requires a managed agent runtime because the tunnel lives on the niri server machine's loopback; a standalone agent must use an embedded tool host or an HTTP URL it can reach.

On the tool-host machine:

```sh
npm run start:tool-host -- --agent <agent-id> \
  --iroh-ticket <ticket printed by the server> \
  --iroh-token <token from data/control/iroh.token>
```

(Equivalently `NIRI_SERVER_IROH_TICKET`, `NIRI_SERVER_IROH_TOKEN`, and `NIRI_AGENT_ID` in the environment.) The tool host binds loopback only, dials out, and keeps the connection open with backoff. All tool traffic is encrypted and token-authenticated. `client: http://...` remains available for trusted networks, while `client: local` embeds the tool host inside the agent runtime.

## Agent memory

Memory lives with the agent runtime under the agent's `home`, separate from any attached tool host:

| Path | Contents |
| --- | --- |
| `<home>/soul.md` | The agent's identity and enduring self-description |
| `<home>/memories/` | Long-term Markdown memories, including core notes, journals, and people files |
| `<home>/state/` | Session, rest snapshot, and failover state |
| `<home>/niri.db` | The searchable memory index and other durable runtime data |

For example, an agent with `home: /home/niri` keeps long-term memories in `/home/niri/memories`.

For routine maintenance, ask the agent to inspect, organize, or repair their own memories using the memory tools. Treat `soul.md` and `memories/` like a private diary: do not read or change them unless the agent asks; it's weird if you do. For backup or recovery, stop the agent runtime and preserve the entire agent home rather than copying only the Markdown files.

## Standalone agents over iroh

Most installations should let the niri server start and supervise their agents. When an agent runtime itself must live on another machine, it can run standalone and dial the niri server over iroh — no open ports, VPN, or port forwarding on either side.

1. Start the niri server. On first boot it generates `data/control/iroh.secret` (endpoint identity) and `data/control/iroh.token` (shared dial-in token, mode `0600`) and logs the ticket; the token is printed once on first generation.
2. In the niri server's `agents/<id>.yaml`, configure the agent as standalone so the server awaits a dial-in instead of starting it. The YAML section and value are still named `worker.mode: remote` for compatibility:

   ```yaml
   worker:
     mode: remote
   ```

3. On the other machine, put the ticket and token in the standalone agent's own YAML and start it:

   ```yaml
   server:
     iroh:
       ticket: <ticket printed by the server>
       token: <token from data/control/iroh.token>
   ```

   ```sh
   npm run start:agent:standalone -- --config /path/to/agent.yaml
   ```

The standalone agent dials the niri server, authenticates with the token, and keeps the connection open (reconnecting with backoff). The niri server exposes the live connection as a loopback tunnel, so all agent traffic — including the event stream — is ordinary HTTP over the encrypted iroh connection. When the agent disconnects, its registration is removed so requests never route to a stale tunnel port.

Managed agents started by the niri server keep using loopback HTTP and need no iroh configuration.

## Agent YAML specification

### Top level

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | string matching `[a-zA-Z0-9_-]+` | no | filename without `.yaml` or `.yml` |
| `name` | string | no | `id` |
| `port` | integer `1..65535` | no | control port plus the file's sorted position |
| `home` | path | no | `data/agents/<id>` |
| `client` | `local`, `iroh`, or an HTTP(S) URL | yes | —; compatibility name for the tool-host connection |
| `workspace` | path | no | repository root; applies to an embedded tool host (`client: local`) |
| `model` | object | no | — |
| `fallback` | object | no | — |
| `embedding` | object | no | — |
| `summary` | object | no | — |
| `discord` | object | no | — |
| `delegation` | object | no | —; named isolated task workers and concurrency limits |
| `mcp` | object keyed by MCP server name | no | `{}` |
| `worker` | object | no | —; compatibility name for agent-runtime placement |
| `server` | object | no | —; niri-server connection for a standalone agent |
| `settings` | object | no | `{}` |

Relative `home` and `workspace` paths resolve from the repository root.

### `model`

| Field | Type |
| --- | --- |
| `provider` | `openai` or `anthropic` |
| `name` | string |
| `baseUrl` | string |
| `apiKey` | string |
| `thinking` | boolean |

### `fallback` and `summary`

| Field | Type |
| --- | --- |
| `name` | string |
| `baseUrl` | string |
| `apiKey` | string |

### `embedding`

| Field | Type |
| --- | --- |
| `name` | string |
| `baseUrl` | string |
| `apiKey` | string |
| `dimensions` | positive integer |

### `discord`

| Field | Type |
| --- | --- |
| `token` | string |
| `enabled` | boolean |
| `botUserId` | string |
| `dmWhitelist` | comma-separated string |
| `posture_bypass.users` | array of Discord user ids |
| `posture_bypass.channels` | array of Discord channel ids |
| `scanChannelIds` | comma-separated string |
| `wakeOnEvent` | boolean |
| `gastownForumChannelId` | Discord forum-channel id; each delegated task is mirrored into a multiplayer thread |

### `delegation`

Delegated task workers run fresh conversations containing only their profile prompt, objective, Niri's bounded accumulated feedback for that profile, and explicitly allowed client tools. They cannot access Discord, general memories, posture, schedules, loop control, or nested delegation. The main agent uses the asynchronous `delegate` tool to spawn, steer, inspect, give feedback to, and cancel them.

```yaml
delegation:
  enabled: true
  maxConcurrent: 2
  timeoutMs: 1800000
  resultMaxChars: 6000
  profiles:
    - name: researcher
      model: gpt-5.6-luna
      systemPrompt: Inspect first and report exact evidence.
      tools: [shell, read_file]
      mcpTools: [web_extract__web_search, web_extract__web_query, web_extract__web_summarize, web_extract__web_extract]
      maxTurns: 30
    - name: coder
      model: gpt-5.6-luna
      systemPrompt: Make the smallest correct change and verify it.
      tools: [shell, read_file, write_file, edit_file]
      mcpTools: [web_extract__web_search, web_extract__web_query, web_extract__web_summarize, web_extract__web_extract]
      maxTurns: 40
```

`tools` is a required, non-empty allowlist containing only `shell`, `read_file`, `write_file`, `edit_file`, and `image_tool`. An empty list never means all tools. `model` optionally overrides the main agent's configured model name for that profile. `mcpTools` is a separate explicit allowlist of namespaced MCP tools; workers never inherit the main agent's MCP catalog implicitly. At most one profile with `write_file` or `edit_file` runs at once against the attached workspace.

`timeoutMs` is the task deadline, including time spent waiting for a collaborator's answer. Provider and client-tool calls already in flight finish cooperatively; cancellation or deadline expiry is applied immediately after they return. Any yielded shell sessions still owned by the worker are terminated when it exits. `delegate status` and `list` return bounded metadata only; full mailbox content enters Niri's context only through an explicit paginated `read`.

`delegate feedback` takes `task_id` and `message`. It works before or after task completion, records the message as durable guidance for that task's worker profile, and mirrors it into the task thread. An active worker also receives it immediately. Future instances of the profile receive recent feedback in chronological order, bounded to 12,000 characters in their system prompt; the complete feedback log remains durable in SQLite.

Set `discord.gastownForumChannelId` to mirror each invocation into a Discord forum thread. Discord is an observable multiplayer surface over the durable SQLite task mailbox: every human who can write in the private server thread is equally authorized to steer the worker, while bot and webhook messages are ignored only to prevent mirror feedback loops. Ordinary replies go to the worker; mentioning Niri also wakes her with the message. Deliberate `task_message` progress updates, blocking questions, and bounded final results enter Niri's context; ordinary worker tool traffic remains in the task transcript and thread.

Runtime tuning belongs under the first-party `runtime` section. It contains `imageMaxBytes`, tool-choice and fallback-limit options, context-compaction thresholds, `lcmSummaryBatchSize` (default `4`, the number of same-depth segments promoted into one multi-parent summary), state migration, and loop limits. Discord batching, gateway tracing, and cooldowns are first-party fields under `discord`.

### `worker` (agent-runtime placement)

| Field | Type |
| --- | --- |
| `mode` | `local` (default) — the niri server starts and supervises the agent; `remote` — a standalone agent starts elsewhere and dials into the niri server over iroh |

### `server`

| Field | Type |
| --- | --- |
| `iroh.ticket` | EndpointTicket of the niri server, printed at server boot |
| `iroh.token` | shared dial-in token from `data/control/iroh.token` |

### `mcp`

Each entry connects from the agent runtime and registers the MCP server's tools. Tools are namespaced as `<server>__<tool>` so independently configured MCP servers cannot overwrite native or tool-host tools. A configured MCP connection must initialize and list its tools before the agent becomes healthy.

HTTP/streamable-HTTP transport:

```yaml
mcp:
  kagi:
    url: https://mcp.example.com/mcp
    auth:
      type: bearer
      token: replace-me
    headers:
      X-Client-Name: mira
```

`auth.type` may be `bearer` with `token`, or `basic` with `username` and `password`. Arbitrary string-valued request headers can also be set with `headers`. URLs must use HTTP(S) and cannot contain embedded credentials.

Local stdio transport:

```yaml
mcp:
  github:
    command: docker
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"]
    cwd: /srv/niri
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: replace-me
```

Command entries run alongside the agent runtime, not on the attached tool host. `args` must be a string array; `env` is merged over a minimal safe process environment rather than inheriting the agent's model or Discord credentials; and `cwd` is optional. Each entry must set exactly one of `url` or `command`.

### `settings`

`settings` accepts string, number, and boolean values keyed by uppercase runtime setting names for uncategorized compatibility overrides. New configuration should use the first-party fields above.

Agent ids, agent-runtime ports, canonical home paths, Discord tokens, and enabled bridge ports must be unique.

Agent YAML files contain credentials and should use mode `0600`. Tool-host endpoints should stay on loopback or a trusted private network.

### Named webhooks

Webhooks are server endpoints configured per agent. Each named entry has its own HMAC-SHA256 secret:

```yaml
webhooks:
  github:
    secret: replace-me
    signatureHeader: x-hub-signature-256
    signaturePrefix: sha256=
  deploy:
    secret: replace-me-too
```

Send the exact JSON body to `POST /agents/<agent-id>/trigger/webhook/<name>`. The signature header defaults to `x-niri-signature`, and its value defaults to the form `sha256=<hex digest>`. A verified request enqueues `[webhook triggered: <name>]` for the agent and preserves the decoded request body under `raw.payload`.

## Check the repository

```sh
npm run typecheck
npm test
npm run build
```
