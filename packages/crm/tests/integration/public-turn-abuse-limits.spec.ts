// Anonymous-chat abuse limits on the public turn route (Port def-uplink-public-turn-anonymous-abuse-limits-removed-with-pilot-throttles-2026-10-19).
//
// Route level against a REAL Postgres through the production driver: the real POST /api/v1/public/agent/[slug]/turn handler, the real
// limiter, IP resolution, conversation capability and relay-proof verification. Only the model call (executeTurn), the operator
// session helpers and activation analytics are faked; every executeTurn call is counted, so "no model call" is measured, not assumed.
// Scratch database only.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND ABUSE_LIMIT_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ABUSE_LIMIT_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const ORG = "d0000000-0000-4000-8000-000000000001";
const ORG2 = "d0000000-0000-4000-8000-000000000002";
const AGENT = "e0000000-0000-4000-8000-000000000001";
const AGENT2 = "e0000000-0000-4000-8000-000000000002";
const SLUG = "abl-fixture--concierge";
const SLUG2 = "abl-fixture-two--concierge";
const KID = "abl1";
const RELAY_KEY = "relay-fixture-key-0123456789abcdef0123456789"; // test-only, >= 32 bytes
const WRONG_KEY = "wrong-fixture-key-0123456789abcdef0123456789";

const modelCalls: string[] = [];
let seq = 0;
const sid = () => `abl-sess-${(++seq).toString(36)}-${randomBytes(4).toString("hex")}`;
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`; // documentation range; each test uses its own client addresses

function mintRelay(input: { sessionId: string; message: string; key?: string; iat?: number; nonce?: string; agentId?: string; agentSlug?: string }) {
  const payload = {
    kid: KID, accountId: 2, inboxId: 11, workspaceId: ORG, agentId: input.agentId ?? AGENT, agentSlug: input.agentSlug ?? SLUG,
    sessionId: input.sessionId, uplinkConversationId: null, chatwootConversationId: "700", chatwootMessageId: String(++seq),
    messageSha256: createHash("sha256").update(input.message, "utf8").digest("hex"), plAssertion: "v1.fixture",
    iat: input.iat ?? Math.floor(Date.now() / 1000), nonce: input.nonce ?? randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", Buffer.from(input.key ?? RELAY_KEY, "utf8")).update(`v1.${encoded}`, "utf8").digest("base64url");
  return `v1.${encoded}.${signature}`;
}

describe("Public turn route: anonymous abuse limits, verified-relay exemption", { skip: !enabled && "set ABUSE_LIMIT_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let POST: (req: import("next/server").NextRequest, c: { params: Promise<{ slug: string }> }) => Promise<Response>;
  let NextRequestCtor: typeof import("next/server").NextRequest;
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };

  const conversations = async () => {
    const r = await db.execute(sql`select count(*)::int as n from agent_conversations`);
    return Number(((Array.isArray(r) ? r : (r as unknown as { rows: Array<{ n: number }> }).rows)[0] as { n: number }).n);
  };
  type Call = { ip: string; slug?: string; sessionId?: string; message?: string; headers?: Record<string, string>; relay?: string | null };
  const turn = async (c: Call) => {
    const sessionId = c.sessionId ?? sid();
    const message = c.message ?? "hello";
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": c.ip, ...(c.headers ?? {}) };
    if (c.relay) headers["x-isola-relay-context"] = c.relay;
    const req = new NextRequestCtor(`http://local/api/v1/public/agent/${c.slug ?? SLUG}/turn`, {
      method: "POST", headers, body: JSON.stringify({ message, anonymous_session_id: sessionId }),
    });
    const res = await POST(req, { params: Promise.resolve({ slug: c.slug ?? SLUG }) });
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  const relayTurn = async (ip: string, extra: Partial<Parameters<typeof mintRelay>[0]> = {}) => {
    const sessionId = sid();
    const message = `relay message ${seq}`;
    return turn({ ip, sessionId, message, relay: mintRelay({ sessionId, message, ...extra }) });
  };
  /** n anonymous turns that must all be admitted (each one a model call). */
  const admitN = async (n: number, ip: string | (() => string), slug = SLUG) => {
    for (let i = 0; i < n; i++) {
      const r = await turn({ ip: typeof ip === "string" ? ip : ip(), slug });
      assert.equal(r.status, 200, `request ${i + 1} should be admitted, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  };
  /** A refused request: the expected status AND no model call AND no conversation row. */
  const assertRefusedWithoutModelCall = async (fn: () => Promise<{ status: number; body: Record<string, unknown> }>, status: number, error: string) => {
    const calls = modelCalls.length, rows = await conversations();
    const r = await fn();
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.equal(modelCalls.length, calls, "a refused request must not reach the model");
    assert.equal(await conversations(), rows, "a refused request must not create a conversation");
  };

  before(async () => {
    const crm = path.resolve(".");
    const keyDir = mkdtempSync(path.join(tmpdir(), "abl-relay-"));
    writeFileSync(path.join(keyDir, "relay.key"), RELAY_KEY + "\n", { mode: 0o600 });
    for (const k of ["PUBLIC_TURN_IP_PER_MINUTE", "PUBLIC_TURN_IP_PER_DAY", "PUBLIC_TURN_AGENT_PER_DAY", "PUBLIC_PILOT_ORG_ID", "PUBLIC_PILOT_AGENT_ID", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PUBLIC_PILOT_REQUIRE_DISTRIBUTED_LIMITER"]) setEnv(k, undefined);
    setEnv("AUTH_SECRET", "abl-fixture-capability-secret-0123456789abcdef");
    setEnv("TRUSTED_PROXY_HOPS", "1");
    setEnv("UPLINK_RELAY_CONTEXT_KEY_FILE", path.join(keyDir, "relay.key"));
    setEnv("UPLINK_RELAY_CONTEXT_KEY_ID", KID);
    setEnv("UPLINK_RELAY_WORKSPACE_ID", ORG);
    setEnv("UPLINK_RELAY_AGENT_SLUG", SLUG);
    setEnv("UPLINK_RELAY_CHATWOOT_ACCOUNT_ID", "2");
    setEnv("UPLINK_RELAY_CHATWOOT_INBOX_ID", "11");

    mock.module(pathToFileURL(path.join(crm, "src/lib/agents/runtime.ts")).href, {
      namedExports: {
        executeTurn: async (input: { conversationId: string }) => {
          modelCalls.push(input.conversationId);
          return { ok: true, assistantMessage: "fixture reply", validators: [], providerCalls: 1, model: "fixture-model", tokensIn: 1, tokensOut: 1, usageComplete: true };
        },
      },
    });
    mock.module(pathToFileURL(path.join(crm, "src/lib/auth/helpers.ts")).href, {
      namedExports: { getCurrentUser: async () => null, getOrgId: async () => null },
    });
    mock.module(pathToFileURL(path.join(crm, "src/lib/analytics/record-agent-activation.ts")).href, {
      namedExports: { recordAgentConversationStarted: async () => undefined },
    });

    ({ db } = await import("@/db"));
    ({ POST } = await import("@/app/api/v1/public/agent/[slug]/turn/route"));
    ({ NextRequest: NextRequestCtor } = await import("next/server"));

    for (const [org, slug, agent] of [[ORG, "abl-fixture", AGENT], [ORG2, "abl-fixture-two", AGENT2]]) {
      await db.execute(sql`insert into organizations (id, name, slug) values (${org}::uuid, ${slug}, ${slug}) on conflict do nothing`);
      await db.execute(sql`insert into agents (id, org_id, name, slug, channel, archetype, status) values (${agent}::uuid, ${org}::uuid, 'Fixture concierge', 'concierge', 'web_chat', 'website-chatbot', 'live') on conflict do nothing`);
    }
  });
  after(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  test("POSITIVE CONTROL: an anonymous visitor is answered, and the turn reaches the (counted) model", async () => {
    const calls = modelCalls.length;
    const r = await turn({ ip: freshIp() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message, "fixture reply");
    assert.equal(modelCalls.length, calls + 1);
  });

  test("the restored defaults are 12 a minute and 150 a day per IP, and 1500 a day per agent", async () => {
    const { resolvePublicTurnLimits } = await import("@/lib/agents/public-turn-limits");
    assert.deepEqual(resolvePublicTurnLimits({}), { perIpPerMinute: 12, perIpPerDay: 150, perAgentPerDay: 1500 });
  });

  test("anonymous: 12 turns in a minute are answered, the 13th is refused (429) with no model call; another IP is unaffected", async () => {
    const ip = freshIp();
    await admitN(12, ip);
    await assertRefusedWithoutModelCall(() => turn({ ip }), 429, "rate_limited");
    assert.equal((await turn({ ip: freshIp() })).status, 200, "control: a different visitor is still answered");
  });

  test("anonymous: 150 turns in a day are answered, the 151st is refused (429) with no model call", async () => {
    setEnv("PUBLIC_TURN_IP_PER_MINUTE", "1000"); // isolate the daily window from the minute window; the daily limit stays at its default 150
    try {
      const ip = freshIp();
      await admitN(150, ip);
      await assertRefusedWithoutModelCall(() => turn({ ip }), 429, "rate_limited");
    } finally { setEnv("PUBLIC_TURN_IP_PER_MINUTE", undefined); }
  });

  test("CONTROL: the live-shaped config (all three limits at 9999999) admits the 13th anonymous turn, so the config delta is part of the fix", async () => {
    setEnv("PUBLIC_TURN_IP_PER_MINUTE", "9999999");
    try {
      const ip = freshIp();
      await admitN(13, ip);
    } finally { setEnv("PUBLIC_TURN_IP_PER_MINUTE", undefined); }
  });

  test("forged: a spoofed leftmost X-Forwarded-For or X-Real-IP does not change the bucket (13th still refused)", async () => {
    const real = freshIp();
    for (let i = 0; i < 12; i++) {
      const r = await turn({ ip: `198.51.100.${i + 1}, ${real}`, headers: { "x-real-ip": `198.51.100.${i + 100}` } });
      assert.equal(r.status, 200);
    }
    await assertRefusedWithoutModelCall(() => turn({ ip: `192.0.2.77, ${real}`, headers: { "x-real-ip": "192.0.2.78" } }), 429, "rate_limited");
  });

  test("forged: relay-looking headers that are not a verified proof grant no exemption (13th still refused)", async () => {
    const ip = freshIp();
    const fake = { "x-isola-relay-verified": "1", "x-isola-relay": "1", "x-relay-verified": "true", "user-agent": "sf-relay" };
    for (let i = 0; i < 12; i++) assert.equal((await turn({ ip, headers: fake })).status, 200);
    await assertRefusedWithoutModelCall(() => turn({ ip, headers: fake }), 429, "rate_limited");
  });

  test("forged: a garbage relay proof, a proof signed with the wrong key, and an expired proof are refused (403) with no model call", async () => {
    const ip = freshIp();
    await assertRefusedWithoutModelCall(() => turn({ ip, relay: "v1.not-a-proof.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), 403, "invalid_channel_context");
    await assertRefusedWithoutModelCall(() => relayTurn(ip, { key: WRONG_KEY }), 403, "invalid_channel_context");
    await assertRefusedWithoutModelCall(() => relayTurn(ip, { iat: Math.floor(Date.now() / 1000) - 120 }), 403, "invalid_channel_context");
    // a valid proof for a different message (the body was swapped after signing)
    const sessionId = sid();
    await assertRefusedWithoutModelCall(() => turn({ ip, sessionId, message: "swapped", relay: mintRelay({ sessionId, message: "original" }) }), 403, "invalid_channel_context");
    // POSITIVE CONTROL: the same minting with the right key, fresh, is accepted
    assert.equal((await relayTurn(ip)).status, 200);
  });

  test("forged: a replayed relay proof is refused (403) with no model call; the original was answered", async () => {
    const ip = freshIp();
    const sessionId = sid();
    const message = "replay me";
    const proof = mintRelay({ sessionId, message });
    const first = await turn({ ip, sessionId, message, relay: proof });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await assertRefusedWithoutModelCall(() => turn({ ip, sessionId, message, relay: proof }), 403, "invalid_channel_context");
  });

  test("legitimate relay: from an IP whose anonymous limit is exhausted, 20 verified relay turns in a minute are all answered", async () => {
    const ip = freshIp();
    await admitN(12, ip);
    await assertRefusedWithoutModelCall(() => turn({ ip }), 429, "rate_limited"); // control: the anonymous limit IS active on this IP
    const calls = modelCalls.length;
    for (let i = 0; i < 20; i++) {
      const r = await relayTurn(ip);
      assert.equal(r.status, 200, `verified relay turn ${i + 1}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(modelCalls.length, calls + 20);
    await assertRefusedWithoutModelCall(() => turn({ ip }), 429, "rate_limited"); // and relay turns did not reset or lift it for anonymous traffic
  });

  test("per agent: the daily ceiling holds across different IPs for anonymous traffic, and verified relay turns are not blocked by it", async () => {
    setEnv("PUBLIC_TURN_AGENT_PER_DAY", "5");
    try {
      // a fresh agent: 5 anonymous turns from 5 different IPs are answered, the 6th from yet another IP is refused
      await admitN(5, freshIp, SLUG2);
      await assertRefusedWithoutModelCall(() => turn({ ip: freshIp(), slug: SLUG2 }), 429, "rate_limited");
      // the relay agent (already above 5 today): anonymous traffic from a brand-new IP is refused at the agent ceiling ...
      await assertRefusedWithoutModelCall(() => turn({ ip: freshIp() }), 429, "rate_limited");
      // ... while verified relay turns for the same agent are still answered
      for (let i = 0; i < 3; i++) assert.equal((await relayTurn(freshIp())).status, 200);
    } finally { setEnv("PUBLIC_TURN_AGENT_PER_DAY", undefined); }
  });
});
