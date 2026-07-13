# @mira/harness-client-node

A persistent Bash plus local read, edit, and image tools behind a tiny HTTP server.

Start the bundled executable:

```sh
harness-tool-client
```

It listens on `0.0.0.0:3002` and uses the client's home directory as its workspace. Optional flags are `--host`, `--port`, `--workspace`, and `--capabilities`.

```ts
import { NodeToolHost, ToolClientHttpServer } from "@mira/harness-client-node"

const host = new NodeToolHost({ workspace: { root: "/srv/workspace" } })
const server = new ToolClientHttpServer({ host })
await server.start()
```

Use the HTTP listener only on loopback or a trusted private network; any reachable caller can invoke its exposed tools.
