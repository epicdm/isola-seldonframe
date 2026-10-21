// Public pilot platform pin — PATH test through the real executeTurn and the
// real lib/ai/client resolution (getAIClient / resolveRuntimeAiClient), with
// only the database and the network faked.
//
// Defect: a workspace BYOK key (needed for Studio Test) made getAIClient
// resolve provider "anthropic", so every metered public-pilot turn hit the
// pilot guard and returned llm_not_configured.
// Fix: a metered turn of the APPROVED pilot workspace (PUBLIC_PILOT_ORG_ID /
// PUBLIC_PILOT_AGENT_ID — the identity the public route already meters on)
// resolves the platform client directly. Every other workspace, every
// non-pilot turn and Studio Test resolve exactly as before.
//
// Run: node --import tsx --experimental-test-module-mocks --test tests/unit/agents/public-pilot-platform-pin.spec.ts

import { after, before, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PgDatabase } from "drizzle-orm/pg-core";

// ── Fake database: every query chain resolves to the rows registered for
// the table passed to .from(); writes resolve to []. No network, no DB.
const tableRows = new Map<unknown, unknown[]>();
function queryChain(): unknown {
  let table: unknown;
  const proxy: unknown = new Proxy(function () {}, {
    get(_target, key) {
      if (key === "then") {
        const rows = tableRows.get(table) ?? [];
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      if (key === "from") {
        return (t: unknown) => {
          table = t;
          return proxy;
        };
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}
// Prototype is PgDatabase so modules that type-check the client at import
// (Auth.js' Drizzle adapter) accept it; no method of it is ever called.
const fakeDb: unknown = new Proxy(
  Object.create(PgDatabase.prototype) as object,
  {
    get(target, key) {
      if (key === "then") return undefined;
      if (key === "constructor" || typeof key === "symbol") return Reflect.get(target, key);
      if (key === "transaction") return async (fn: (tx: unknown) => unknown) => fn(fakeDb);
      return () => queryChain();
    },
  },
);
mock.module("@/db", { namedExports: { db: fakeDb } });

// ── Fake provider network: record every model request, answer end_turn.
type Seen = { host: string; apiKey: string | null; model: string | undefined };
const seen: Seen[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
  seen.push({ host: url.host, apiKey: headers.get("x-api-key"), model: body.model });
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model ?? "unknown",
      content: [{ type: "text", text: "Hello, how can I help you today?" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 8 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const PILOT_ORG = "11111111-1111-4111-8111-111111111111";
const PILOT_AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
// Fake, non-credential placeholders (never real keys).
const BYOK_KEY = "fake-byok-workspace-key";
const PLATFORM_KEY = "fake-platform-file-key";

let tmp: string;
let keyFile: string;
type Runtime = typeof import("../../../src/lib/agents/runtime");
type Client = typeof import("../../../src/lib/ai/client");
type Schema = typeof import("../../../src/db/schema");
let runtime: Runtime;
let client: Client;
let schema: Schema;
const envBefore = { ...process.env };

function setWorkspace(opts: { orgId: string; agentId: string; byok: boolean }) {
  tableRows.clear();
  tableRows.set(schema.agentConversations, [
    { id: "conv-1", agentId: opts.agentId, orgId: opts.orgId, status: "active", channelMeta: null, turnCount: 0 },
  ]);
  tableRows.set(schema.agents, [
    { id: opts.agentId, orgId: opts.orgId, name: "Front desk", archetype: "website_chatbot", status: "live", blueprint: {} },
  ]);
  tableRows.set(schema.organizations, [
    {
      id: opts.orgId,
      name: "Workspace",
      slug: "ws",
      soul: null,
      timezone: "UTC",
      parentAgencyId: null,
      integrations: opts.byok ? { anthropic: { apiKey: BYOK_KEY } } : {},
    },
  ]);
  tableRows.set(schema.users, [{ planId: "scale", orgId: opts.orgId }]);
  tableRows.set(schema.seldonUsage, [{ value: 0 }]);
}

function setPilotEnv(overrides: Record<string, string | undefined> = {}) {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SF_AGENCY_KEY_INHERIT;
  delete process.env.SF_USAGE_CAP_PAUSE;
  process.env.MODEL_API_KEY_FILE = keyFile;
  process.env.MODEL_BASE_URL = "https://api.deepseek.com/anthropic";
  process.env.MODEL_NAME = "deepseek-flash";
  process.env.PUBLIC_PILOT_ORG_ID = PILOT_ORG;
  process.env.PUBLIC_PILOT_AGENT_ID = PILOT_AGENT;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "pilot-pin-"));
  keyFile = path.join(tmp, "model-key");
  writeFileSync(keyFile, PLATFORM_KEY);
  schema = await import("../../../src/db/schema");
  client = await import("../../../src/lib/ai/client");
  runtime = await import("../../../src/lib/agents/runtime");
});

after(() => {
  globalThis.fetch = realFetch;
  process.env = envBefore;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  setPilotEnv();
});

describe("public pilot turn — platform pin on the approved pilot workspace", () => {
  test("(1) pilot turn with a workspace BYOK key resolves the PLATFORM client and proceeds", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
    const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi", publicPilotSpend: true });
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    assert.ok(seen.length >= 1, "a provider call was made");
    for (const call of seen) {
      assert.equal(call.host, "api.deepseek.com", "every pilot call goes to the platform endpoint");
      assert.equal(call.apiKey, PLATFORM_KEY, "the platform key is used");
      assert.notEqual(call.apiKey, BYOK_KEY, "the BYOK key is never sent on a pilot turn");
      assert.equal(call.model, "deepseek-flash");
    }
  });

  test("(2) control — pilot turn with NO platform key still refuses llm_not_configured, zero provider calls", async () => {
    setPilotEnv({ MODEL_API_KEY_FILE: undefined });
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
    const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi", publicPilotSpend: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "llm_not_configured");
    assert.equal(seen.length, 0);
  });

  test("(2b) control — pilot guard still refuses a non-deepseek-flash model or a non-deepseek endpoint", async () => {
    for (const overrides of [{ MODEL_NAME: "deepseek-v4-pro" }, { MODEL_BASE_URL: "https://example.com/anthropic" }]) {
      seen.length = 0;
      setPilotEnv(overrides);
      setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
      const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi", publicPilotSpend: true });
      assert.equal(result.ok, false, JSON.stringify(overrides));
      if (!result.ok) assert.equal(result.reason, "llm_not_configured", JSON.stringify(overrides));
      assert.equal(seen.length, 0, JSON.stringify(overrides));
    }
  });

  test("(3) another tenant's metered turn with BYOK is NOT re-routed — today's refusal, zero provider calls", async () => {
    // Multi-gate control: the pin keys on the workspace id, so the other
    // tenant must genuinely differ from the configured pilot workspace.
    assert.notEqual(OTHER_ORG, process.env.PUBLIC_PILOT_ORG_ID);
    assert.equal(process.env.PUBLIC_PILOT_ORG_ID, PILOT_ORG);
    setWorkspace({ orgId: OTHER_ORG, agentId: OTHER_AGENT, byok: true });
    const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi", publicPilotSpend: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "llm_not_configured");
    assert.equal(seen.length, 0, "the platform key is never spent for another tenant");
  });

  test("(4) non-pilot turn on the pilot workspace with BYOK still uses the BYOK key", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
    const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi" });
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    assert.ok(seen.length >= 1);
    for (const call of seen) {
      assert.equal(call.host, "api.anthropic.com");
      assert.equal(call.apiKey, BYOK_KEY);
    }
  });

  test("(4b) non-pilot turn of another tenant with BYOK still uses its BYOK key", async () => {
    setWorkspace({ orgId: OTHER_ORG, agentId: OTHER_AGENT, byok: true });
    const result = await runtime.executeTurn({ conversationId: "conv-1", userMessage: "hi" });
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    for (const call of seen) {
      assert.equal(call.host, "api.anthropic.com");
      assert.equal(call.apiKey, BYOK_KEY);
    }
  });

  test("(5) Studio Test resolution unchanged: getAIClient stays BYOK-first (byok -> allowed, none -> needs_byok)", async () => {
    const { resolveStudioBuildGate } = await import("../../../src/lib/agent-templates/studio-build-gate");
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
    const withKey = await client.getAIClient({ orgId: PILOT_ORG });
    assert.equal(withKey.mode, "byok");
    assert.equal(withKey.provider, "anthropic");
    assert.deepEqual(resolveStudioBuildGate(withKey.mode), { ok: true });
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: false });
    const withoutKey = await client.getAIClient({ orgId: PILOT_ORG });
    assert.equal(withoutKey.provider, "platform");
    assert.equal(resolveStudioBuildGate(withoutKey.mode).ok, false);
  });
});
