# @mira/harness-client-node

A Node.js tool host providing persistent Bash plus local read, edit, and image tools behind a tiny HTTP server. Package, binary, and type names retain their original `client` wording for compatibility.

Start the bundled executable:

```sh
harness-tool-host
```

The previous `harness-tool-client` binary remains as an alias.

It listens on `0.0.0.0:3002` and uses the tool-host user's home directory as its workspace. Optional flags are `--host`, `--port`, `--workspace`, and `--capabilities`. The file tools separate creation from mutation: `write_file` creates a new path and refuses existing files, while `edit_file` replaces one exact occurrence in an existing file.

```ts
import { NodeToolHost, ToolClientHttpServer } from "@mira/harness-client-node"

const host = new NodeToolHost({ workspace: { root: "/srv/workspace" } })
const server = new ToolClientHttpServer({ host })
await server.start()
```

Use the HTTP listener only on loopback or a trusted private network; any reachable caller can invoke its exposed tools.
