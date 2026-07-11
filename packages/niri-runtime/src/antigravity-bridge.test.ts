import assert from "node:assert/strict";
import test from "node:test";
import {
  mapModelName,
  convertSchemaTypes,
  mapOpenaiMessagesToGemini,
  mapAnthropicMessagesToGemini,
  createBridgeServer
} from "./antigravity-bridge";

test("mapModelName maps correctly", () => {
  assert.equal(mapModelName("gemini-3.5-flash-medium"), "gemini-3.5-flash-low");
  assert.equal(mapModelName("gemini-3.5-flash-high"), "gemini-3-flash-agent");
  assert.equal(mapModelName("claude-sonnet-4-6"), "gemini-3.5-flash-low");
  assert.equal(mapModelName("some-unknown-model"), "some-unknown-model");
  assert.equal(mapModelName("model-with-flash-in-name"), "gemini-3.5-flash-low");
});

test("convertSchemaTypes makes type uppercase recursively", () => {
  const input = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
      tags: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["name"]
  };

  const expected = {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      age: { type: "INTEGER" },
      tags: {
        type: "ARRAY",
        items: { type: "STRING" }
      }
    },
    required: ["name"]
  };

  assert.deepEqual(convertSchemaTypes(input), expected);
});

test("mapOpenaiMessagesToGemini maps user and assistant messages", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi there!" }
  ];

  const result = mapOpenaiMessagesToGemini(messages, {});
  assert.ok(result.systemInstruction);
  assert.equal(result.systemInstruction.role, "user");
  assert.deepEqual(result.systemInstruction.parts, [{ text: "You are a helpful assistant." }]);

  assert.equal(result.contents.length, 2);
  assert.equal(result.contents[0].role, "user");
  assert.deepEqual(result.contents[0].parts, [{ text: "Hello!" }]);
  assert.equal(result.contents[1].role, "model");
  assert.deepEqual(result.contents[1].parts, [{ text: "Hi there!" }]);
});

test("mapAnthropicMessagesToGemini maps user and assistant messages and merges consecutive ones", () => {
  const messages = [
    { role: "user", content: "Hello!" },
    { role: "user", content: "Are you there?" },
    { role: "assistant", content: "Yes!" }
  ];

  const result = mapAnthropicMessagesToGemini(messages, {});
  assert.equal(result.contents.length, 2);
  assert.equal(result.contents[0].role, "user");
  assert.deepEqual(result.contents[0].parts, [{ text: "Hello!" }, { text: "Are you there?" }]);
  assert.equal(result.contents[1].role, "model");
  assert.deepEqual(result.contents[1].parts, [{ text: "Yes!" }]);
});

test("createBridgeServer exposes model routes without browser CORS", async () => {
  const server = createBridgeServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { origin: "https://attacker.example" }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  const data = JSON.parse(res.payload);
  assert.ok(Array.isArray(data.data));
  assert.ok(data.data.some((m: any) => m.id === "Gemini 3.5 Flash (High)"));

  const preflight = await server.inject({
    method: "OPTIONS",
    url: "/v1/chat/completions",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "POST"
    }
  });
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);

  await server.close();
});
