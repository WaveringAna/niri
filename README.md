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

### `settings`

`settings` accepts string, number, and boolean values keyed by uppercase runtime setting names.

> **TODO:** Promote active settings into first-party YAML sections for tools, context management, Discord batching/cooldowns, state, and bridges. Remove the settings that have no runtime reader.

#### Tools and model calls

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `IMAGE_TOOL_MAX_BYTES` | `1000000` | Maximum image size accepted by the image tool. |
| `PRIMARY_TOOL_CHOICE` | `auto` | Tool-choice mode for primary model requests: `required`, `auto`, or `none`. |
| `FALLBACK_TOOL_CHOICE` | `auto` | Tool-choice mode for fallback model requests. |
| `FALLBACK_ENFORCE_CONTEXT_LIMIT` | `false` | Enforce the configured fallback context limit before sending a request. |

#### Context management

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `CONTEXT_COMPACT_TRIGGER_TOKENS` | `100000` | Start context compaction at this token estimate. |
| `TOKEN_NUDGE_THRESHOLD` | `120000` | No current runtime reader. |
| `CONTEXT_COMPACT_TARGET_TOKENS` | `65000` | No current runtime reader. |
| `CONTEXT_COMPACT_RECENT_MESSAGES` | `80` | No current runtime reader. |
| `CONTEXT_COMPACT_CHUNK_MESSAGES` | `32` | No current runtime reader. |
| `CONTEXT_COMPACT_SUMMARY_MAX_CHARS` | `500000` | No current runtime reader. |

#### Discord

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `DISCORD_GATEWAY_TRACE` | `true` | Log gateway tracing details. |
| `DISCORD_GATEWAY_RAW_FALLBACK` | `true` | Use raw gateway events when the normal event path cannot handle an event. |
| `DISCORD_BATCH_INTERVAL_MS` | `8000` | Interval between Discord batch checks. |
| `DISCORD_BATCH_ONLY_CONFIGURED` | `true` | Limit batches to DMs and configured scan channels. |
| `DISCORD_PENDING_AUTO_SEEN_MINUTES` | `10` | Mark pending messages seen after this many minutes. |
| `DISCORD_BATCH_SCAN` | `true` | Scan configured channels before building each batch. |
| `DISCORD_BATCH_MAX_MESSAGES` | `120` | Maximum messages included in one batch. |
| `COOLDOWN_CHANNELS` | `channelId,2000,0400` | Channel response windows as repeated `channelId,startHHMM,endHHMM` triples. |
| `COOLDOWN_TZ` | `America/New_York` | Time zone used for cooldown windows. |
| `DISCORD_WAKE_ON_DM` | `true` | No current runtime reader. |
| `DISCORD_WHITELIST` | Discord user ids | No current runtime reader; use `discord.dmWhitelist`. |

#### State and process

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `NIRI_MIGRATE_LEGACY_STATE` | `true` | Copy root-level session snapshots into the agent state directory once. |
| `AGENT_UID` | `1001` | No worker runtime reader; used only by the Docker build and Compose configuration. |
| `AGENT_GID` | `1001` | No worker runtime reader; used only by the Docker build and Compose configuration. |

#### Bridges

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `ANTIGRAVITY_BRIDGE_ENABLED` | Niri: `false`; Lyra: `true` | Start the Antigravity bridge. |
| `ANTIGRAVITY_BRIDGE_PORT` | `8000` | Antigravity bridge loopback port. |
| `ANTIGRAVITY_BINARY_PATH` | `/home/niri/.local/bin/agy` | Antigravity executable. |
| `CODEX_BRIDGE_ENABLED` | Niri: `true`; Lyra: `false` | Start the Codex bridge. |
| `CODEX_BRIDGE_PORT` | `8001` | Codex bridge loopback port. |
| `CODEX_BRIDGE_MODEL` | `gpt-5.6-sol` | Model presented by the Codex bridge. |
| `CODEX_BRIDGE_REASONING_EFFORT` | `low` | Codex bridge reasoning effort. |

Agent ids, worker ports, canonical home paths, Discord tokens, and enabled bridge ports must be unique.

Agent YAML files contain credentials and should use mode `0600`. Tool-client endpoints should stay on loopback or a trusted private network.

## Check the repository

```sh
npm run typecheck
npm test
npm run build
```
