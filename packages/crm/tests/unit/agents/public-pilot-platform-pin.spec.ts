// Public pilot platform pin — PATH test through the real executeTurn and the
// real lib/ai/client resolution (getAIClient / resolveRuntimeAiClient), with
// only the database and the network faked.
//
// Defect: a workspace BYOK key (needed for Studio Test) made getAIClient
// resolve provider "anthropic", so every metered public-pilot turn hit the
// pilot guard and returned llm_not_configured.
// Fix: a metered turn of the APPROVED pilot workspace that is also the approved
// concierge (the agent the route's verified relay binding names) resolves the
// platform client directly. Workspace-wide pilot metering is NOT workspace-wide
// model selection: every other agent of the pilot workspace, every other
// workspace, every non-pilot turn and Studio Test resolve exactly as before.
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
// Live ids (2026-10-21): the WhatsApp relay concierge (uplink_sf-relay-pl-prod SF_AGENT_ID) and the agent
// PUBLIC_PILOT_AGENT_ID names today ("Personal Line Assistant (DRAFT - sandbox)").
const CONCIERGE_AGENT = "28a55c69-ef04-416f-9c91-7d72e9e21345";
const PILOT_AGENT = "a5e7235d-9fe1-409a-b824-d7810fc13ab1";
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

// The verified relay binding the public route builds (route.ts) only after the
// relay proof's HMAC/freshness/expected agent and the configured relay scope
// (UPLINK_RELAY_WORKSPACE_ID / UPLINK_RELAY_AGENT_SLUG) all matched.
function relayContext(workspaceId: string, agentId: string) {
  return {
    kind: "chatwoot" as const,
    proof: "fake-proof",
    binding: {
      accountId: 1,
      inboxId: 2,
      chatwootConversationId: "3",
      workspaceId,
      agentId,
      agentSlug: "ws--concierge",
      sessionId: "session-1",
    },
  };
}

async function pilotTurn(agentId: string, orgId: string, relay?: ReturnType<typeof relayContext>) {
  return runtime.executeTurn({
    conversationId: "conv-1",
    userMessage: "hi",
    publicPilotSpend: true,
    ...(relay ? { trustedRelayToolContext: relay } : {}),
  });
}

function assertRefusedWithoutProviderCall(result: Awaited<ReturnType<Runtime["executeTurn"]>>, label: string) {
  assert.equal(result.ok, false, label);
  if (!result.ok) assert.equal(result.reason, "llm_not_configured", label);
  assert.equal(seen.length, 0, `${label}: no provider call`);
}

describe("public pilot turn — platform pin only for the approved concierge in the approved workspace", () => {
  test("(0) field-distinctness control: concierge, configured pilot agent and other ids genuinely differ", () => {
    assert.notEqual(CONCIERGE_AGENT, PILOT_AGENT);
    assert.equal(process.env.PUBLIC_PILOT_AGENT_ID, PILOT_AGENT, "PUBLIC_PILOT_AGENT_ID is NOT the concierge (live state)");
    assert.notEqual(OTHER_ORG, PILOT_ORG);
    assert.equal(process.env.PUBLIC_PILOT_ORG_ID, PILOT_ORG);
    const binding = relayContext(PILOT_ORG, CONCIERGE_AGENT).binding;
    assert.notEqual(binding.workspaceId, binding.agentId, "binding workspace and agent fields are distinct values");
  });

  test("(1) concierge (28a55c69) metered relay turn with a workspace BYOK key resolves the PLATFORM client and proceeds", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
    const result = await pilotTurn(CONCIERGE_AGENT, PILOT_ORG, relayContext(PILOT_ORG, CONCIERGE_AGENT));
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    assert.ok(seen.length >= 1, "a provider call was made");
    for (const call of seen) {
      assert.equal(call.host, "api.deepseek.com", "every concierge call goes to the platform endpoint");
      assert.equal(call.apiKey, PLATFORM_KEY, "the platform key is used");
      assert.notEqual(call.apiKey, BYOK_KEY, "the BYOK key is never sent on the concierge pilot turn");
      assert.equal(call.model, "deepseek-flash");
    }
  });

  test("(2) control — concierge turn with NO platform key still refuses llm_not_configured", async () => {
    setPilotEnv({ MODEL_API_KEY_FILE: undefined });
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
    assertRefusedWithoutProviderCall(await pilotTurn(CONCIERGE_AGENT, PILOT_ORG, relayContext(PILOT_ORG, CONCIERGE_AGENT)), "no platform key");
  });

  test("(2b) control — pilot guard still refuses a non-deepseek-flash model or a non-deepseek endpoint", async () => {
    for (const overrides of [{ MODEL_NAME: "deepseek-v4-pro" }, { MODEL_BASE_URL: "https://example.com/anthropic" }]) {
      seen.length = 0;
      setPilotEnv(overrides);
      setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
      assertRefusedWithoutProviderCall(
        await pilotTurn(CONCIERGE_AGENT, PILOT_ORG, relayContext(PILOT_ORG, CONCIERGE_AGENT)),
        JSON.stringify(overrides),
      );
    }
  });

  test("(6) another public agent in the SAME workspace (a5e7235d) with BYOK is unchanged — fails closed as today", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: PILOT_AGENT, byok: true });
    assertRefusedWithoutProviderCall(await pilotTurn(PILOT_AGENT, PILOT_ORG), "same-workspace agent, no relay binding");
    seen.length = 0;
    // Even a binding naming the concierge does not pin a different agent's turn (agent field must match).
    assertRefusedWithoutProviderCall(
      await pilotTurn(PILOT_AGENT, PILOT_ORG, relayContext(PILOT_ORG, CONCIERGE_AGENT)),
      "same-workspace agent, binding for the concierge",
    );
  });

  test("(6b) concierge metered turn WITHOUT the verified relay binding (e.g. web widget) is unchanged — fails closed as today", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
    assertRefusedWithoutProviderCall(await pilotTurn(CONCIERGE_AGENT, PILOT_ORG), "concierge, no relay binding");
  });

  test("(3) another tenant's metered relay turn with BYOK is NOT re-routed — today's refusal", async () => {
    setWorkspace({ orgId: OTHER_ORG, agentId: OTHER_AGENT, byok: true });
    assertRefusedWithoutProviderCall(await pilotTurn(OTHER_AGENT, OTHER_ORG, relayContext(OTHER_ORG, OTHER_AGENT)), "other tenant");
  });

  test("(4) non-pilot turn of the concierge with BYOK still uses the BYOK key (positive control: fake provider sees calls)", async () => {
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
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
    assert.ok(seen.length >= 1);
    for (const call of seen) {
      assert.equal(call.host, "api.anthropic.com");
      assert.equal(call.apiKey, BYOK_KEY);
    }
  });

  test("(5) Studio Test resolution unchanged: getAIClient stays BYOK-first (byok -> allowed, none -> needs_byok)", async () => {
    const { resolveStudioBuildGate } = await import("../../../src/lib/agent-templates/studio-build-gate");
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: true });
    const withKey = await client.getAIClient({ orgId: PILOT_ORG });
    assert.equal(withKey.mode, "byok");
    assert.equal(withKey.provider, "anthropic");
    assert.deepEqual(resolveStudioBuildGate(withKey.mode), { ok: true });
    setWorkspace({ orgId: PILOT_ORG, agentId: CONCIERGE_AGENT, byok: false });
    const withoutKey = await client.getAIClient({ orgId: PILOT_ORG });
    assert.equal(withoutKey.provider, "platform");
    assert.equal(resolveStudioBuildGate(withoutKey.mode).ok, false);
  });
});
