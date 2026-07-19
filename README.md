# Niri

## Run the server

```sh
npm ci
cp agents/mira.example.yaml agents/mira.yaml
chmod 600 agents/mira.yaml
# edit agents/mira.yaml
npm start
```

The server reads every `.yaml` and `.yml` file in `agents/`. Files ending in `.example.yaml` or `.example.yml` are skipped.

## Run a client

```sh
cd apps/client
npm run start
```

The client listens on `0.0.0.0:3002` and runs `shell`, `read_file`, `edit_file`, and `image_tool` from the client's home directory. It also exposes a chunked `read_blob` operation, which the worker uses internally to attach client-side files to Discord messages.

## Remote workers over iroh

Workers do not have to run on the same host as the control plane. The server binds an [iroh](https://github.com/n0-computer/iroh) endpoint (QUIC with NAT traversal) on boot and prints an **EndpointTicket**; a worker anywhere can dial in over that ticket — no open ports, VPN, or port forwarding on either side.

1. Start the server. On first boot it generates `data/control/iroh.secret` (endpoint identity) and `data/control/iroh.token` (shared dial-in token, mode `0600`) and logs the ticket; the token is printed once on first generation.
2. In the server's `agents/<id>.yaml`, mark the agent as remote so the control plane awaits a dial-in instead of spawning a worker:

   ```yaml
   worker:
     mode: remote
   ```

3. On the remote machine, put the ticket and token in the worker's own agent yaml and run the standalone worker:

   ```yaml
   server:
     iroh:
       ticket: <ticket printed by the server>
       token: <token from data/control/iroh.token>
   ```

   ```sh
   npm run start:worker:standalone -- --config /path/to/agent.yaml
   ```

The worker dials the server, authenticates with the token, and keeps the connection open (reconnecting with backoff). The control plane exposes each live connection as a loopback tunnel, so all worker traffic — including the event stream — is ordinary HTTP over the encrypted iroh connection. When a worker disconnects, its registration is removed so requests never route to a stale tunnel port.

Local supervised workers keep using loopback HTTP and need no iroh configuration.

## Agent memory

Memory lives on the server under the agent's `home`, separate from any attached client:

| Path | Contents |
| --- | --- |
| `<home>/soul.md` | The agent's identity and enduring self-description |
| `<home>/memories/` | Long-term Markdown memories, including core notes, journals, and people files |
| `<home>/state/` | Session, rest snapshot, and failover state |
| `<home>/niri.db` | The searchable memory index and other durable runtime data |

For example, an agent with `home: /home/niri` keeps long-term memories in `/home/niri/memories`.

For routine maintenance, ask the agent to inspect, organize, or repair their own memories using the memory tools. Treat `soul.md` and `memories/` like a private diary: do not read or change them unless the agent asks; it's weird if you do. For backup or recovery, stop the worker and preserve the entire agent home rather than copying only the Markdown files.

## Agent YAML specification

### Top level

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | string matching `[a-zA-Z0-9_-]+` | no | filename without `.yaml` or `.yml` |
| `name` | string | no | `id` |
| `port` | integer `1..65535` | no | control port plus the file's sorted position |
| `home` | path | no | `data/agents/<id>` |
| `client` | `local` or an HTTP(S) URL | yes | — |
| `workspace` | path | no | repository root; applies to `client: local` |
| `model` | object | no | — |
| `fallback` | object | no | — |
| `embedding` | object | no | — |
| `summary` | object | no | — |
| `discord` | object | no | — |
| `mcp` | object keyed by MCP server name | no | `{}` |
| `worker` | object | no | — |
| `server` | object | no | — |
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
| `scanChannelIds` | comma-separated string |
| `wakeOnEvent` | boolean |

Runtime tuning belongs under the first-party `runtime` section. It contains `imageMaxBytes`, tool-choice and fallback-limit options, context-compaction thresholds, state migration, loop limits, and `antigravity`/`codex` bridge settings. Discord batching, gateway tracing, and cooldowns are first-party fields under `discord`.

### `worker`

| Field | Type |
| --- | --- |
| `mode` | `local` (default) — the control plane spawns and supervises the worker; `remote` — the control plane waits for the worker to dial in over iroh |

### `server`

| Field | Type |
| --- | --- |
| `iroh.ticket` | EndpointTicket of the control plane, printed at server boot |
| `iroh.token` | shared dial-in token from `data/control/iroh.token` |

### `mcp`

Each entry connects from that agent's server-side worker and registers the remote server's tools. Tools are namespaced as `<server>__<tool>` so independently configured MCP servers cannot overwrite native or client tools. A configured MCP connection must initialize and list its tools before the worker becomes healthy.

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

Command entries run on the server, not on the attached client. `args` must be a string array; `env` is merged over a minimal safe process environment rather than inheriting the agent's model or Discord credentials; and `cwd` is optional. Each entry must set exactly one of `url` or `command`.

### `settings`

`settings` accepts string, number, and boolean values keyed by uppercase runtime setting names for uncategorized compatibility overrides. New configuration should use the first-party fields above.

Agent ids, worker ports, canonical home paths, Discord tokens, and enabled bridge ports must be unique.

Agent YAML files contain credentials and should use mode `0600`. Tool-client endpoints should stay on loopback or a trusted private network.

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
