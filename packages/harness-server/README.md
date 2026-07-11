# @mira/harness-server

An authenticated in-memory broker for one agent worker and its attached tool client.

```sh
npm install @mira/harness-server @mira/harness-core @mira/harness-protocol
```

Mount the four operations at one endpoint prefix. This Fastify example matches `RemoteToolClient`:

```ts
import Fastify from "fastify"
import { ClientToolBroker, handleClientBrokerHttpRequest } from "@mira/harness-server"

const app = Fastify()
const broker = new ClientToolBroker({ agentId: "mira", token: process.env.TOOL_TOKEN })

for (const operation of ["hello", "poll", "results", "detach"] as const) {
  app.post(`/client/${operation}`, async (request, reply) => {
    const response = await handleClientBrokerHttpRequest(
      broker,
      operation,
      request.headers.authorization,
      request.body,
    )
    return reply.code(response.statusCode).send(response.body)
  })
}
```

Pass the broker as your model loop's `ClientToolExecutor`. It has no server-local tool fallback. Leases bind agent, client, and invocation ownership; a different client cannot take over pending work; matching late results remain valid; detach resolves pending work as unknown.

The broker is intentionally in-memory. Persist model-loop checkpoints separately and run one broker per agent worker.
