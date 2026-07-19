import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { NodeToolHost, ToolClientHttpServer } from "@mira/harness-client-node"
import { HttpToolClient } from "@mira/harness-server"

// attachments.ts resolves worker-relative paths against NIRI_HOME at module
// load, so point it at a temp home before importing the module under test.
// Dynamic import is required here: a static import would evaluate agent-config
// (and freeze NIRI_HOME) before the temp directory exists.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "niri-attachments-home-"))
process.env.NIRI_HOME = home
process.env.NIRI_AGENT_ID = "test-agent"
const { resolveDiscordAttachments, __discordAttachmentsTest } = await import("./attachments.js")
const { buildDiscordSendRequest } = await import("./state.js")

test.after(() => fs.rm(home, { recursive: true, force: true }))

test("worker path attachments resolve relative to the agent home", async () => {
  await fs.mkdir(path.join(home, "images"), { recursive: true })
  const png = randomBytes(2048)
  await fs.writeFile(path.join(home, "images", "pic.png"), png)

  const [attachment] = await resolveDiscordAttachments([{ path: "images/pic.png" }])
  assert.equal(attachment.name, "pic.png")
  assert.deepEqual(attachment.data, png)

  const [absolute] = await resolveDiscordAttachments([{ path: path.join(home, "images", "pic.png"), name: "renamed.png", description: "alt" }])
  assert.equal(absolute.name, "renamed.png")
  assert.equal(absolute.description, "alt")

  await assert.rejects(() => resolveDiscordAttachments([{ path: "images/missing.png" }]), /attachment file not found/)
})

test("attachment inputs are validated", async () => {
  assert.deepEqual(await resolveDiscordAttachments([]), [])
  await assert.rejects(
    () => resolveDiscordAttachments([{ path: "a.png", url: "https://example.com/a.png" }]),
    /exactly one of path, client_path, or url/,
  )
  await assert.rejects(() => resolveDiscordAttachments([{ name: "a.png" }]), /exactly one of path, client_path, or url/)
  const tooMany = Array.from({ length: 11 }, () => ({ path: "images/pic.png" }))
  await assert.rejects(() => resolveDiscordAttachments(tooMany), /too many attachments/)
})

test("url attachments reject non-public targets", async () => {
  for (const url of [
    "http://127.0.0.1:9/secret",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/secret",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(() => resolveDiscordAttachments([{ url }]), /non-public|http\(s\)/, url)
  }

  assert.equal(__discordAttachmentsTest.isPublicAddress("8.8.8.8"), true)
  assert.equal(__discordAttachmentsTest.isPublicAddress("2606:4700:4700::1111"), true)
  for (const blocked of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "127.0.0.1", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(__discordAttachmentsTest.isPublicAddress(blocked), false, blocked)
  }
})

test("url attachments resolve through the fetch seam", async () => {
  const payload = randomBytes(4096)
  const [attachment] = await resolveDiscordAttachments(
    [{ url: "https://cdn.example.com/files/report.pdf" }],
    { fetchUrl: async (url) => ({ data: payload, finalUrl: url }) },
  )
  assert.equal(attachment.name, "report.pdf")
  assert.deepEqual(attachment.data, payload)
})

test("discord send request carries attachment bytes and metadata to rest.post", () => {
  const dataA = randomBytes(100)
  const dataB = randomBytes(200)
  const request = buildDiscordSendRequest({
    content: "hello",
    channelId: "chan1",
    referenceMessageId: "msg9",
    attachments: [
      { name: "a.png", data: dataA, description: "first" },
      { name: "b.txt", data: dataB },
    ],
  })

  assert.deepEqual(request.body.attachments, [
    { id: 0, filename: "a.png", description: "first" },
    { id: 1, filename: "b.txt" },
  ])
  assert.deepEqual(request.files, [
    { name: "a.png", data: dataA },
    { name: "b.txt", data: dataB },
  ])
  assert.deepEqual(request.body.message_reference, { message_id: "msg9", channel_id: "chan1", fail_if_not_exists: false })
  assert.deepEqual(request.body.allowed_mentions, { replied_user: false })

  const plain = buildDiscordSendRequest({ content: "hi", channelId: "c" })
  assert.ok(!("files" in plain))
  assert.ok(!("attachments" in plain.body))
  assert.ok(!("message_reference" in plain.body))
})

test("client_path attachments transfer byte-identical files over the real client transport", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "niri-attachments-client-"))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const blob = randomBytes(700 * 1024)
  const blobPath = path.join(workspace, "blob.bin")
  await fs.writeFile(blobPath, blob)

  const host = new NodeToolHost({ workspace: { id: "test", root: workspace } })
  const server = new ToolClientHttpServer({ host, listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  const client = new HttpToolClient({ agentId: "test-agent", endpoint: address.url })
  await client.start()
  t.after(async () => {
    await client.stop()
    await server.stop()
    await host.stop()
  })

  const [attachment] = await resolveDiscordAttachments([{ client_path: blobPath }], {
    readClientBlob: (clientPath) => __discordAttachmentsTest.readClientBlob(clientPath, client),
  })
  assert.equal(attachment.name, "blob.bin")
  assert.deepEqual(attachment.data, blob)
})

test("client_path attachments fail clearly when the client lacks read_blob", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "niri-attachments-nocap-"))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  await fs.writeFile(path.join(workspace, "blob.bin"), randomBytes(64))

  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  const server = new ToolClientHttpServer({ host, listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  const client = new HttpToolClient({ agentId: "test-agent", endpoint: address.url })
  await client.start()
  t.after(async () => {
    await client.stop()
    await server.stop()
    await host.stop()
  })

  await assert.rejects(
    () =>
      resolveDiscordAttachments([{ client_path: path.join(workspace, "blob.bin") }], {
        readClientBlob: (clientPath) => __discordAttachmentsTest.readClientBlob(clientPath, client),
      }),
    /does not expose read_blob/,
  )
})
