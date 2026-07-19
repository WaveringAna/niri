import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"
import { verifyWebhookSignature } from "./server"

test("webhook HMAC verification is scoped to each named entry", () => {
  const body = Buffer.from('{"action":"push"}')
  const github = { secret: "github-secret", signatureHeader: "x-hub-signature-256" }
  const deploy = { secret: "deploy-secret" }
  const signature = `sha256=${createHmac("sha256", github.secret).update(body).digest("hex")}`

  assert.equal(verifyWebhookSignature(body, signature, github), true)
  assert.equal(verifyWebhookSignature(body, signature, deploy), false)
  assert.equal(verifyWebhookSignature(body, undefined, github), false)
  assert.equal(verifyWebhookSignature(body, "sha256=not-hex", github), false)
})
