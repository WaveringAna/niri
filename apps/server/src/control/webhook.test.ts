import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"
import { createControlServer, verifyWebhookSignature } from "./server"
import { initControlDb, upsertAgent } from "./db"

test("webhook HMAC verification is scoped to each named entry", () => {
  const body = Buffer.from('{"action":"push"}')
  const github = { secret: "github-secret", signatureHeader: "x-hub-signature-256" }
  const deploy = { secret: "deploy-secret" }
  const signature = `sha256=${createHmac("sha256", github.secret).update(body).digest("hex")}`

  assert.equal(verifyWebhookSignature(body, signature, github), true)
  assert.equal(verifyWebhookSignature(body, signature, deploy), false)
  assert.equal(verifyWebhookSignature(body, undefined, github), false)
  assert.equal(verifyWebhookSignature(body, [signature, signature], github), false)
  assert.equal(verifyWebhookSignature(body, "sha256=not-hex", github), false)
})

test("webhook route rejects duplicate signature headers", async () => {
  initControlDb()
  upsertAgent({ id: "niri", name: "niri", baseUrl: "http://127.0.0.1:1" })
  const body = { action: "push" }
  const raw = Buffer.from(JSON.stringify(body))
  const signature = `sha256=${createHmac("sha256", "deploy-secret").update(raw).digest("hex")}`
  const app = createControlServer({ webhooks: new Map([["niri", { deploy: { secret: "deploy-secret", signatureHeader: "x-hook-signature" } }]]) })
  try {
    const response = await app.inject({
      method: "POST",
      url: "/agents/niri/trigger/webhook/deploy",
      headers: { "content-type": "application/json", "x-hook-signature": [signature, signature] },
      payload: body,
    })
    assert.equal(response.statusCode, 401)
  } finally {
    await app.close()
  }
})
