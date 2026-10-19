import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  createAnthropicByokClient,
  createPlatformFileBackedClient,
  createPlatformFileBackedClientOrNull,
} from "../../src/lib/ai/platform-client";

type SeenRequest = {
  apiKey: string | undefined;
  authorization: string | undefined;
  model: string | undefined;
};

const requests: SeenRequest[] = [];
let server: Server;
let baseURL: string;
let directory: string;
let previousAnthropicBaseUrl: string | undefined;
let previousModelBaseUrl: string | undefined;

const forwardSdkFetchToLocalMock: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const localUrl = new URL(`${url.pathname}${url.search}`, baseURL);
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  return globalThis.fetch(localUrl, {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "uplink-sdk-client-"));
  previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  previousModelBaseUrl = process.env.MODEL_BASE_URL;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}") as { model?: string };
      const apiKeyHeader = request.headers["x-api-key"];
      requests.push({
        apiKey: Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader,
        authorization: request.headers.authorization,
        model: payload.model,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_local_test",
        type: "message",
        role: "assistant",
        model: payload.model ?? "test-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseURL = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
  if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
  if (previousModelBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
  else process.env.MODEL_BASE_URL = previousModelBaseUrl;
});

async function send(client: Anthropic, model: string) {
  return client.messages.create({
    model,
    max_tokens: 8,
    messages: [{ role: "user", content: "synthetic integration probe" }],
  });
}

test("file-backed platform client sends its string key and configured model to the local endpoint", async () => {
  const secret = "synthetic-file-key-header-test";
  const file = join(directory, "valid-key");
  await writeFile(file, ` ${secret} \n`, "utf8");

  const client = await createPlatformFileBackedClient(
    file,
    "https://api.deepseek.com/anthropic",
    forwardSdkFetchToLocalMock,
  );
  await send(client, "deepseek-chat");

  assert.deepEqual(requests.at(-1), {
    apiKey: secret,
    authorization: undefined,
    model: "deepseek-chat",
  });
});

test("missing and empty credential files fail before any request and do not disclose synthetic contents", async () => {
  const initialCount = requests.length;
  const secret = "synthetic-empty-file-secret-must-not-appear";
  const emptyFile = join(directory, "empty-key");
  await writeFile(emptyFile, "  \n", "utf8");

  for (const [file, expected] of [
    [join(directory, "missing-key"), /credential file is unavailable/],
    [emptyFile, /credential file is empty/],
  ] as const) {
    let message = "";
    try {
      const client = await createPlatformFileBackedClient(
        file,
        "https://api.deepseek.com/anthropic",
        forwardSdkFetchToLocalMock,
      );
      await send(client, "deepseek-chat");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, expected);
    assert.equal(message.includes(secret), false);
  }
  assert.equal(requests.length, initialCount);
});

test("missing, empty, and unreadable credential files disable the public agent client safely", async () => {
  for (const read of [
    async () => { throw new Error("ENOENT secret-path detail"); },
    async () => "  \n",
    async () => { throw new Error("EACCES private-path detail"); },
  ]) {
    const client = await createPlatformFileBackedClientOrNull(
      "/synthetic/model-key",
      "https://model.invalid/v1",
      undefined,
      read,
    );
    assert.equal(client, null);
  }
});

test("credential rotation is observed by the next client resolution", async () => {
  const file = join(directory, "rotating-key");
  const oldKey = "synthetic-rotation-old-key";
  const newKey = "synthetic-rotation-new-key";
  await writeFile(file, oldKey, "utf8");
  await send(await createPlatformFileBackedClient(file, "https://api.deepseek.com/anthropic", forwardSdkFetchToLocalMock), "deepseek-chat");
  await writeFile(file, newKey, "utf8");
  await send(await createPlatformFileBackedClient(file, "https://api.deepseek.com/anthropic", forwardSdkFetchToLocalMock), "deepseek-chat");

  assert.deepEqual(requests.slice(-2).map((request) => request.apiKey), [oldKey, newKey]);
});

test("Anthropic BYOK keeps SDK endpoint selection and caller-selected model", async () => {
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  process.env.MODEL_BASE_URL = "https://unused-platform-endpoint.invalid";
  const byokKey = "synthetic-anthropic-byok-key";
  const client = createAnthropicByokClient(byokKey, forwardSdkFetchToLocalMock);
  await send(client, "claude-sonnet-4-5-20250929");

  assert.equal(client.baseURL, "https://api.anthropic.com");
  assert.deepEqual(requests.at(-1), {
    apiKey: byokKey,
    authorization: undefined,
    model: "claude-sonnet-4-5-20250929",
  });
});
