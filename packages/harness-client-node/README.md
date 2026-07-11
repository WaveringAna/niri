# @mira/harness-client-node

Node.js client tools: persistent Bash, native or Docker-backed reads/edits, bounded images, an atomic replay journal, and long-poll transport.

## Standalone client

```sh
npm install --global @mira/harness-client-node
export HARNESS_ENDPOINT='https://server.example/agents/mira/client'
export HARNESS_AGENT_ID='mira'
export HARNESS_CLIENT_ID='mira-macbook'
export HARNESS_TOKEN='agent-specific-pairing-token'
export HARNESS_CLIENT_WORKSPACE="$HOME/Developer/project"
harness-tool-client
```

The journal defaults to `~/.local/state/mira-harness/clients`, outside the attached project. Set `HARNESS_STATE_DIR` or `HARNESS_JOURNAL` to move it. Completed results are uploaded after reconnect before polling resumes, then removed after acknowledgement.

## Library use

```ts
import { NodeToolHost, RemoteToolClient } from "@mira/harness-client-node"

const host = new NodeToolHost({
  capabilities: ["shell", "read_file", "edit_file", "image_tool"],
  workspace: { id: "project", root: "/workspace" },
})

const client = new RemoteToolClient({
  endpoint: "https://server.example/client",
  agentId: "mira",
  clientId: "mira-macbook",
  token: process.env.TOOL_TOKEN!,
  host,
  journalPath: "/var/lib/harness/client.json",
})

await client.start()
```

Run one `NodeToolHost` per process. Creating another host invalidates the earlier host so it fails closed instead of crossing workspaces. The workspace is the initial working directory and metadata, not a security sandbox: shell can change directories and native file tools accept absolute paths with the client account's permissions. Use a dedicated OS account or container for untrusted agents.

By default the child shell receives a small operational environment allowlist, does not source user startup files, and cannot see the client daemon's tokens or arbitrary parent secrets. Add explicit variables with `shellEnvironment` or `HARNESS_SHELL_ENV_JSON`. Docker mode requires both `HARNESS_CONTAINER` and `HARNESS_CONTAINER_USER`; the workspace and image root are container paths.

Requirements: Node.js 20+, Bash, and the native prerequisites for `node-pty`. Docker file helpers additionally require Python 3 in the container.
