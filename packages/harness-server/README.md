# @mira/harness-server

Direct HTTP caller for a remote harness tool host. The exported `HttpToolClient` name is retained for API compatibility.

```ts
import { HttpToolClient } from "@mira/harness-server"

const tools = new HttpToolClient({
  agentId: "mira",
  endpoint: "http://mira-macbook.local:3002",
})

await tools.start()
const result = await tools.execute({
  agentId: "mira",
  tool: "shell",
  args: { command: "pwd" },
})
```

Use the endpoint only on a trusted network; any reachable caller can invoke its exposed tools.
