import type { FastifyReply } from "fastify"

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
} as const

export function applyCorsHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    reply.header(name, value)
  }
}
