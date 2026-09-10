# runtime configuration and the niri cli

## start here

```sh
npm install
npm run build:packages
npm link                 # optional: puts `niri` on your shell's path
niri serve               # start the control server as a daemon
niri                     # interactive agents view
```

`niri serve` runs the same server as `npm start`, detached: output appends to `data/control/server.log`, the pid lives in `data/control/server.pid`, and `niri serve stop|restart|status|logs [--lines N]` manages it. Both honor `--port`, `--host` (loopback or wildcard only), and `--agents DIR`. The command waits until the server answers `/health` before returning, and refuses to double-start a port that is already listening.

Without linking, use `npm run niri -- <arguments>` from this checkout. The cli
currently runs from the checkout through `tsx`; it is not a standalone binary.

Bare `niri` opens a terminal agents view. Select with arrows or `j`/`k`, enter
opens chat, `c` creates a stopped agent, `r` refreshes, and `q` exits. In chat, `/a`
(or the left arrow on an empty line) returns to the view; `/q` quits. Piped output is a tab-separated agent list; `--json`
returns structured output. The chat renderer retains thinking/tool toggles,
markdown, streamed output, usage statistics, and `/status`.

```sh
niri agents create nova
niri config show nova
niri config set nova model.name gpt-4.1-mini
niri agents start nova
niri chat nova
niri agents stop nova
niri agents restart nova
niri config history nova
niri config rollback nova 1
```

`NIRI_SERVER_URL` or `--server` selects the server. It defaults to
`http://127.0.0.1:3000`. Config and lifecycle operations need an operator token
from `NIRI_TOKEN` or `--token`. For a local server the cli reads
`data/control/admin.token`, or `$NIRI_CONTROL_HOME/admin.token`. The server creates
this private file; it does not print the credential. Remote connections should
use a trusted encrypted channel. Existing chat/read APIs retain their previous
network-access rules; this is not a blanket authentication retrofit.

## defaults for new agents

These defaults apply to plain API/CLI creation. Interactive creation (`niri agents create` in a terminal, or `c` in the agents view) asks for the model provider, model name, api base url (enter keeps the provider default), api key (paste, `env:VAR_NAME`, or skip), and whether to enable Discord with a bot token and your user id. Non-interactive creation, `--config`/seed files, and automatic YAML imports skip the prompts and keep exactly what the input declares:

| setting | default |
| --- | --- |
| lifecycle | stopped; `--start` explicitly opts in |
| name | agent id |
| home | `data/agents/<id>` under the checkout |
| placement | managed local runtime |
| tool host | embedded (`client: local`), checkout as initial workspace |
| model | asked at creation: provider, model name, api key — nothing is assumed |
| model credential | pasted key, or `env:VAR_NAME` reference; skipped fields are simply unset |
| thinking | off |
| discord | asked at creation: keep disabled, or bot token plus your user id for the DM whitelist |
| discord postures | unset; the runtime's own wording is neutral, and no persona is assumed for a new agent |
| delegation | enabled, concurrency 2, no profiles until configured |
| compaction | trigger 100,000 tokens, hard trigger 120,000 tokens, minimum 4 new messages |
| summary batch size | 4 |
| image limit | 1,000,000 bytes |
| primary/fallback tool choice | auto |
| fallback context limit | enforced |
| legacy state migration | disabled; a new agent must not inherit another persona's state |
| self-editing | enabled for behavioral fields |
| seed enforcement | off |
| ports | automatically allocated, stable across subsequent agent creation |

The agent cannot boot a cloud model until its credential is configured. Creating
an agent does not wake a model or spend tokens. An embedded tool host is **not a
sandbox**. Choose an isolated external host when the agent should not share the
server machine's filesystem access.

## durable config and seeds

The server keeps configuration, revisions, application state, seed baselines,
and edit history in `data/control/control.db`. This is separate from the live
routing registry. A remote disconnect never deletes configuration. Back up the
control directory as well as each agent's home.

Existing `agents/*.yaml` files are imported on the first boot that sees their id.
Later boots use stored config. Missing/empty seed directories are allowed, and
removing a seed file never deletes an agent. Updating a seed is explicit:

```sh
niri agents create nova --from agent.yaml
niri config diff nova agent.yaml
niri config apply nova agent.yaml
niri seed agent.yaml
niri seed agent.yaml --overwrite
```

`seed` skips existing ids by default. Explicit apply compares the previous seed,
new seed, and live config. Non-conflicting changes merge; conflicting edits fail
instead of overwriting live changes. Fields removed from a seed are removed only
when this does not conflict with a live edit. Arrays are replaced as a unit.
Ordinary API patches use JSON merge-patch semantics: objects merge, arrays
replace, and `null` removes a field.

Home and embedding-dimension changes require a separate migration; changing them
through a patch or seed apply is refused. Agent ids are immutable.

## nix

`nix/agent.example.nix` is a working-shape example; `nix/default.nix` exports pure
`mkAgent`, `secretFromEnv`, and `secretFromFile` helpers. No nixpkgs is required.

```sh
niri seed nix/agent.example.nix
niri config diff nova nix/agent.example.nix
niri config apply nova nix/agent.example.nix
```

The cli runs `nix eval --json --file` and sends the result through the same config
API as YAML. Nix is needed only on the machine evaluating the seed. No Nix daemon
or evaluator is embedded in the niri server. Only evaluate trusted Nix files.

Never put literal credentials in a Nix expression/store output. Use runtime
references instead:

```yaml
secrets:
  model.apiKey:
    env: OPENAI_API_KEY
  discord.token:
    file: /run/credentials/niri/discord
```

For Nix file references, pass the runtime filename as a **string**, not a Nix
path literal that copies a credential into the store. Config reads/history redact
secret values and references. Inline legacy credentials remain supported, but
private file permissions are not encryption at rest.

## self-editing and enforcement

The operator controls policy:

```yaml
configPolicy:
  selfEdit: true
  agentWebhooks: false
  allowedPaths: [model, fallback, summary, runtime, delegation, discord]
  enforcedPaths: [model.name]
```

An empty allowlist disables all generic agent edits. `selfEdit: false` disables
the self-edit interface. Generic patches always exclude secret fields,
deployment, operator policy, arbitrary environment settings, webhooks, and MCP
commands. Provider endpoint changes need an exact explicit allowlisted path such
as `model.baseUrl`, because they can redirect credentials.

`agentWebhooks: true` opts the agent into the narrow webhook provisioning API.
It does not expose generic webhook or secret editing. The control plane generates
the signing secret, persists it in the protected config store, keeps config and
history views redacted, refreshes webhook routing, and returns only the new
webhook's signing receipt to its owning agent:

```python
cfg = await niri.config.get()
hook = await niri.webhooks.create(
    "deploy",
    expected_revision=cfg["revision"],
    signature_header="X-Hub-Signature-256",
    request_id="deploy-webhook-1",
    reason="receive deployment events",
)
print(hook["path"], hook["secret"])
```

The default signature is the lowercase `x-niri-signature` header containing
`sha256=<hex HMAC-SHA256 of the exact request body>`. The returned `url` uses the
control plane's loopback origin; use `path` with the externally reachable control
plane origin when configuring the sender. Keep `request_id` to retry safely after
a deadline: an exact replay returns the same secret without another revision.

`enforcedPaths` binds selected values from the seed/config. Ordinary edits,
including operator patches, cannot change those values. Explicit seed apply can
change them or remove enforcement. This is optional **field enforcement**, not a
background file watcher or automatic `nixos-rebuild` integration. Seeds remain
seed-only by default.

Inside the agent's Python repl:

```python
cfg = await niri.config.get()
receipt = await niri.config.update(
    {"model": {"name": "gpt-4.1-mini"}},
    expected_revision=cfg["revision"],
    request_id="my-model-change-1",
    reason="adjust the model for this task",
)
await niri.config.status()
await niri.config.history()
```

The runtime forwards these requests with an agent-scoped credential. The Python
kernel never receives the operator credential. Identity comes from the execution
grant, not a caller-supplied agent id. These are API protections, not a replacement
for an OS sandbox.

### posture wording belongs to the agent

The runtime acts on two postures and describes only what they do: `hearth` lets
Discord events enter context live, and `forge` queues DMs and non-bypass channel
messages until the agent returns (`discord.posture_bypass` always gets through).
Every word that gives a posture a voice lives in the agent's own config:

```yaml
discord:
  postures:
    hearth:
      description: warm, open, available; DMs answered in real time.
      guidance: choose it when someone needs you.
      bio: around — say hi.
    forge:
      description: focused and closed; the same fire, aimed.
      bio: heads down building; your messages are safe.
      reminder: two hours aimed; who is waiting?
```

`description` and `guidance` are appended verbatim to the posture tool the model
sees, `bio` becomes the Discord status while the posture is held, and `reminder`
replaces the mechanical forge nudge. Names are free-form (`[a-z0-9_-]+`), so an
agent may write wording for postures it invents, but only `hearth` and `forge`
change runtime behaviour. Unset fields fall back to neutral defaults that name no
person and carry no persona. `discord.postures.*` is agent-editable under the
default policy, so an agent can rewrite its own wording; an operator pins it with
`enforcedPaths`. Wording is applied to a worker at spawn, so changes take effect
on the next agent restart. `agents/mira.example.yaml` carries a full example.

## saved is not active

Every write has a revision and actor. A stale `expectedRevision` fails with a
conflict. Reusing a request id with the same operation replays its receipt;
reusing it for a different request fails. A timeout is not proof a write failed:
retry with the same request id and payload, or inspect current state.

Responses distinguish desired revision from `application.activeRevision` and
report `draft`, `pending`, `applying`, `active`, or `failed`. Either way the
control plane waits for the worker to be safe — no host-RPC lease, no turn in
flight — before it touches anything, and failed application remains visible.

A revision whose every changed setting is **hot** is applied to the running
worker: the control plane posts the delta to the worker, the worker rewrites
those variables and runs the reload hooks that own them, and the revision becomes
active without a restart. The worker answers with the keys it applied, and a
partial answer fails the revision naming what is missing, rather than leaving the
runtime half-way between two revisions.

Everything else is **cold** and is applied by replacing the worker once it is
idle, exactly as before. Classification is an allowlist, so a setting nobody has
classified — including a new one — costs a restart instead of drifting.

| hot today | why it can change live |
| --- | --- |
| `discord.dmWhitelist`, `discord.posture_bypass`, `discord.scanChannelIds`, `discord.batchOnlyConfigured`, `discord.pendingAutoSeenMinutes`, `discord.cooldownChannels`, `discord.cooldownTz` | the Discord pipeline reads them per message |
| `discord.postures` | read per use, and a hook repaints the Discord presence and bio |
| `discord.batchIntervalMs`, `discord.batchMaxMessages`, `discord.batchScan` | read when the digest timer fires, and a hook restarts that timer |

| cold today | why a restart |
| --- | --- |
| `discord.token`, `discord.botUserId`, `discord.enabled` | gateway identity and lifetime; a change means a reconnect, which replacement already does well. A reconnect hook could make these hot later. |
| `model.*`, `fallback.*`, `summary.*`, thinking and tool-choice flags | resolved once into module constants in the runner; hot swapping needs those constants to become getters first |
| `embedding.*` | vector tables are built for one embedding model and width |
| `runtime.*` compaction and image limits | read in some paths, captured at import in others; ambiguous means cold |
| `mcp`, `delegation` | they spawn transports and profiles |
| `port`, `home`, `client`, `workspace`, `worker.mode`, `server.iroh.*` | process identity and transports |

Standalone remote runtimes do not yet receive automatic config deployment or
restarts. Their desired config can be saved, but remains pending until deployed.
The repl config bridge currently requires a loopback HTTP authority; without one
it reports `unavailable`. Managed control listeners support loopback or wildcard
bind addresses. Do not mistake a saved remote revision for an applied revision.

## api summary

- `POST /agents`: `{id, config?, start?, seed?}`
- `GET /agents/:id/config` and `/config/status`
- `PATCH /agents/:id/config`: `{patch, expectedRevision, reason?, requestId?}`
- `GET /agents/:id/config/history`
- `POST /agents/:id/config/diff` and `/config/seed`: `{config, expectedRevision}`
- `POST /agents/:id/config/rollback`: `{revision, expectedRevision}`
- `POST /agents/:id/start`, `/stop`, `/restart`

Agent-scoped tokens may read and patch only their own config. Creation, seeds,
rollback, and lifecycle control require an operator token. The legacy
`/agents/:id/shutdown` also requires that token on a configured control server.
