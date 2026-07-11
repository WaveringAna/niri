# @mira/harness-core

Host-neutral client tool interfaces and a capability-filtered model catalog.

```sh
npm install @mira/harness-core @mira/harness-protocol
```

```ts
import { createClientToolCatalog, type ClientToolHost } from "@mira/harness-core"

const tools = createClientToolCatalog({
  clientCapabilities: ["shell", "read_file"],
  workspace: { id: "project", root: "/workspace" },
})
```

Implement `ClientToolHost` for another execution environment, or use `NodeToolHost` from `@mira/harness-client-node`. The catalog exposes only capabilities attached to the current client; dispatch must check the current catalog again before executing a model-returned call.
