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

The client listens on `0.0.0.0:3002` and runs `shell`, `read_file`, `edit_file`, and `image_tool` from the client's home directory.

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

## Check the repository

```sh
npm run typecheck
npm test
npm run build
```
