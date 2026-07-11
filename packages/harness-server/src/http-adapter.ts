import type { ClientToolBroker } from "./client-broker.js"

export type ClientBrokerOperation = "hello" | "poll" | "results" | "detach"

export type ClientBrokerHttpResponse = {
  statusCode: number
  body: unknown
}

export async function handleClientBrokerHttpRequest(
  broker: ClientToolBroker,
  operation: ClientBrokerOperation,
  authorization: unknown,
  body: unknown,
): Promise<ClientBrokerHttpResponse> {
  if (!broker.hasConfiguredToken()) {
    return { statusCode: 503, body: { error: "tool client pairing is disabled" } }
  }
  if (!broker.isAuthorized(authorization)) {
    return { statusCode: 401, body: { error: "invalid tool client authorization" } }
  }

  try {
    switch (operation) {
      case "hello":
        return { statusCode: 200, body: broker.register(body) }
      case "poll":
        return { statusCode: 200, body: await broker.poll(body) }
      case "results":
        return { statusCode: 200, body: broker.acceptResult(body) }
      case "detach":
        return { statusCode: 200, body: broker.detach(body) }
    }
  } catch (error) {
    return {
      statusCode: operation === "hello" ? 400 : 409,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}
