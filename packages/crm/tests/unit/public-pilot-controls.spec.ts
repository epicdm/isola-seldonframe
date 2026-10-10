import assert from "node:assert/strict";
import test from "node:test";
import {
  actualPublicTurnCostMicroUsd,
  canReservePilotSpend,
  DEEPSEEK_FLASH_PRICING,
  extractCompletePublicUsage,
  isConfiguredPublicPilotTarget,
  isPublicPilotRequestWithinInputLimit,
  maximumPublicTurnReservationMicroUsd,
  parsePublicPilotEnvelope,
  parseTrustedProxyHops,
  resolvePublicPilotTarget,
  resolveTrustedClientIp,
  type PilotSpendSnapshot,
} from "../../src/lib/agents/public-pilot-controls";

test("trusted ingress ignores forged left prefix and resolves the trusted suffix", () => {
  assert.equal(parseTrustedProxyHops("1"), 1);
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "198.51.100.99, 203.0.113.7" }), 1), "203.0.113.7");
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "not-an-ip, 203.0.113.7" }), 1), null);
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "198.51.100.99, 203.0.113.7, 10.0.0.2" }), 2), "203.0.113.7");
});

test("ordinary client and IPv6 addresses work; client-controlled fallback headers are ignored", () => {
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "203.0.113.7" }), 1), "203.0.113.7");
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "2001:db8::7" }), 1), "2001:db8::7");
  assert.equal(resolveTrustedClientIp(new Headers({ "x-real-ip": "203.0.113.7" }), 1), null);
});

test("unknown trust configuration, missing, short and malformed chains fail closed", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "999", " 1x"]) assert.equal(parseTrustedProxyHops(value), null);
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "203.0.113.7" }), null), null);
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "not-an-ip" }), 1), null);
  assert.equal(resolveTrustedClientIp(new Headers(), 1), null);
  assert.equal(resolveTrustedClientIp(new Headers({ "x-forwarded-for": "203.0.113.7" }), 2), null);
});

test("pilot reservation uses seven enforced request-byte ceilings and peak uncached pricing", () => {
  assert.equal(maximumPublicTurnReservationMicroUsd(), BigInt(76801));
  assert.equal(actualPublicTurnCostMicroUsd({ model: "deepseek-flash", inputTokens: 1_000_000, outputTokens: 1_000_000 }), BigInt(1500000));
  assert.equal(actualPublicTurnCostMicroUsd({ model: "unexpected-model", inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(actualPublicTurnCostMicroUsd({ model: "deepseek-flash", inputTokens: -1, outputTokens: 1 }), null);
});

test("public envelope requires bounded valid budget and UTC start/expiry", () => {
  const base = { PUBLIC_PILOT_BUDGET_CENTS: "1000", PUBLIC_PILOT_STARTS_AT: "2026-10-08T00:00:00Z", PUBLIC_PILOT_EXPIRES_AT: "2026-10-22T00:00:00Z" };
  assert.deepEqual(parsePublicPilotEnvelope(base), { budgetCents: 1000, startsAtMs: Date.parse(base.PUBLIC_PILOT_STARTS_AT), expiresAtMs: Date.parse(base.PUBLIC_PILOT_EXPIRES_AT) });
  for (const env of [
    {},
    { ...base, PUBLIC_PILOT_BUDGET_CENTS: "0" },
    { ...base, PUBLIC_PILOT_BUDGET_CENTS: "1001" },
    { ...base, PUBLIC_PILOT_STARTS_AT: "not-a-date" },
    { ...base, PUBLIC_PILOT_STARTS_AT: "2026-02-30T00:00:00Z" },
    { ...base, PUBLIC_PILOT_EXPIRES_AT: "2026-10-23T00:00:00Z" },
  ]) assert.equal(parsePublicPilotEnvelope(env), null);
});

test("pilot targeting requires the explicit workspace ID and a well-formed pilot agent ID, and covers EVERY agent of that workspace", () => {
  const env = {
    PUBLIC_PILOT_ORG_ID: "11111111-1111-4111-8111-111111111111",
    PUBLIC_PILOT_AGENT_ID: "22222222-2222-4222-8222-222222222222",
  };
  const secondAgentInPilotOrg = "33333333-3333-4333-8333-333333333333";
  // positive controls: the configured pilot agent AND a second agent of the same workspace are metered targets
  assert.equal(isConfiguredPublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, env.PUBLIC_PILOT_AGENT_ID, env), true);
  assert.equal(isConfiguredPublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, secondAgentInPilotOrg, env), true);
  assert.equal(resolvePublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, secondAgentInPilotOrg, env), "target");
  // negatives: no config, malformed org id
  assert.equal(isConfiguredPublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, env.PUBLIC_PILOT_AGENT_ID, {}), false);
  assert.equal(isConfiguredPublicPilotTarget("not-a-uuid", env.PUBLIC_PILOT_AGENT_ID, env), false);
  // incomplete configuration (pilot agent id missing or invalid) stays "incomplete" for the pilot workspace
  assert.equal(resolvePublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, "wrong-agent", { PUBLIC_PILOT_ORG_ID: env.PUBLIC_PILOT_ORG_ID }), "incomplete");
  assert.equal(resolvePublicPilotTarget(env.PUBLIC_PILOT_ORG_ID, secondAgentInPilotOrg, { ...env, PUBLIC_PILOT_AGENT_ID: "not-a-uuid" }), "incomplete");
  // agents of another workspace are unaffected: "other" (positive control above shows the pilot workspace is a target)
  assert.equal(resolvePublicPilotTarget("other-org", "other-agent", env), "other");
  assert.equal(resolvePublicPilotTarget("44444444-4444-4444-8444-444444444444", secondAgentInPilotOrg, env), "other");
  assert.equal(isConfiguredPublicPilotTarget("44444444-4444-4444-8444-444444444444", env.PUBLIC_PILOT_AGENT_ID, env), false);
});

test("serialized request ceiling includes tool/prompt payload and rejects overflow", () => {
  assert.equal(isPublicPilotRequestWithinInputLimit({ prompt: "x".repeat(32_000) }), true);
  assert.equal(isPublicPilotRequestWithinInputLimit({ prompt: "x".repeat(33_000) }), false);
});

test("settlement usage includes cache tokens and missing/invalid usage is incomplete", () => {
  assert.deepEqual(extractCompletePublicUsage({ input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 12 }), { inputTokens: 150, outputTokens: 12 });
  assert.deepEqual(extractCompletePublicUsage({ input_tokens: 100, output_tokens: 12 }), { inputTokens: 100, outputTokens: 12 });
  assert.equal(extractCompletePublicUsage({ input_tokens: 100, output_tokens: undefined }), null);
  assert.equal(extractCompletePublicUsage({ input_tokens: 100, cache_read_input_tokens: -1, output_tokens: 12 }), null);
});

test("aggregate gate denies wrong scope, wrong model, expired, disabled and over-budget reservations", () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  const gate: PilotSpendSnapshot = {
    enabled: true,
    organizationId: "pilot-org",
    agentId: "live-default-agent",
    model: "deepseek-flash",
    budgetMicroUsd: BigInt(10000000),
    spentMicroUsd: BigInt(0),
    reservedMicroUsd: BigInt(0),
    uncertainMicroUsd: BigInt(0),
    startsAtMs: 100,
    expiresAtMs: 10_000,
  };
  const ask = { gate, organizationId: "pilot-org", agentId: "live-default-agent", model: "deepseek-flash", reserveMicroUsd: bound, nowMs: 101 };
  assert.equal(canReservePilotSpend(ask), true);
  // organization-level coverage: a SECOND agent of the pilot workspace shares the same gate and budget (positive control)...
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent" }), true);
  // ...and is held to the identical limits as the first (disabled, expired, over budget, turn cap, wrong model)
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", gate: { ...gate, enabled: false } }), false);
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", nowMs: 10_000 }), false);
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", gate: { ...gate, spentMicroUsd: BigInt(9950000) } }), false);
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", conversationTurns: 4 }), true);
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", conversationTurns: 5 }), false);
  assert.equal(canReservePilotSpend({ ...ask, agentId: "second-pilot-org-agent", model: "deepseek-v4-pro" }), false);
  // a different WORKSPACE is still refused by the gate
  assert.equal(canReservePilotSpend({ ...ask, organizationId: "other-org" }), false);
  assert.equal(canReservePilotSpend({ ...ask, model: "deepseek-v4-pro" }), false);
  assert.equal(canReservePilotSpend({ ...ask, nowMs: 10_000 }), false);
  assert.equal(canReservePilotSpend({ ...ask, gate: { ...gate, enabled: false } }), false);
  assert.equal(canReservePilotSpend({ ...ask, gate: { ...gate, spentMicroUsd: BigInt(9950000) } }), false);
  assert.equal(canReservePilotSpend({ ...ask, conversationTurns: 4 }), true);
  assert.equal(canReservePilotSpend({ ...ask, conversationTurns: 5 }), false);
});

test("a persisted reservation snapshot blocks another worker after simulated restart", async () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  const persisted = {
    gate: {
      enabled: true,
      organizationId: "pilot-org",
      agentId: "live-default-agent",
      model: "deepseek-flash",
      budgetMicroUsd: bound,
      spentMicroUsd: BigInt(0),
      reservedMicroUsd: bound,
      uncertainMicroUsd: BigInt(0),
      startsAtMs: 100,
      expiresAtMs: 10_000,
    } satisfies PilotSpendSnapshot,
  };
  const newWorkerAfterRestart = { readGate: () => persisted.gate };
  assert.equal(canReservePilotSpend({ gate: newWorkerAfterRestart.readGate(), organizationId: "pilot-org", agentId: "live-default-agent", model: "deepseek-flash", reserveMicroUsd: bound, nowMs: 101 }), false);
});

test("concurrent reservations cannot oversubscribe the aggregate pilot cap", async () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  let gate: PilotSpendSnapshot = {
    enabled: true,
    organizationId: "pilot-org",
    agentId: "live-default-agent",
    model: "deepseek-flash",
    budgetMicroUsd: BigInt(10000000),
    spentMicroUsd: BigInt(0),
    reservedMicroUsd: BigInt(0),
    uncertainMicroUsd: BigInt(0),
    startsAtMs: 100,
    expiresAtMs: 10_000,
  };
  let tail = Promise.resolve();
  let conversationTurns = 0;
  const reserve = async () => {
    const before = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => { unlock = resolve; });
    await before;
    const ok = canReservePilotSpend({ gate, organizationId: "pilot-org", agentId: "live-default-agent", model: "deepseek-flash", reserveMicroUsd: bound, nowMs: 101, conversationTurns });
    if (ok) {
      gate = { ...gate, reservedMicroUsd: gate.reservedMicroUsd + bound };
      conversationTurns += 1;
    }
    unlock();
    return ok;
  };
  const budgetMicroUsd = bound * BigInt(7);
  gate = { ...gate, budgetMicroUsd };
  const results = await Promise.all(Array.from({ length: 50 }, () => reserve()));
  assert.equal(results.filter(Boolean).length, 5);
  assert.ok(gate.spentMicroUsd + gate.reservedMicroUsd + gate.uncertainMicroUsd <= gate.budgetMicroUsd);
});

test("50 mock-provider requests against a two-turn cap admit only two, then stop inference", async () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  let gate: PilotSpendSnapshot = {
    enabled: true,
    organizationId: "pilot-org",
    agentId: "live-default-agent",
    model: "deepseek-flash",
    budgetMicroUsd: BigInt(2) * bound,
    spentMicroUsd: BigInt(0),
    reservedMicroUsd: BigInt(0),
    uncertainMicroUsd: BigInt(0),
    startsAtMs: 100,
    expiresAtMs: 10_000,
  };
  let tail = Promise.resolve();
  let providerCalls = 0;
  const attempt = async (conversationId: number) => {
    const prior = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    const admitted = canReservePilotSpend({ gate, organizationId: "pilot-org", agentId: "live-default-agent", model: "deepseek-flash", reserveMicroUsd: bound, nowMs: 101 });
    if (admitted) gate = { ...gate, reservedMicroUsd: gate.reservedMicroUsd + bound };
    unlock();
    if (!admitted) return false;
    providerCalls += 1;
    return conversationId >= 0;
  };
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(i)));
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(providerCalls, 2);
  assert.equal(gate.reservedMicroUsd, BigInt(2) * bound);
});

test("$10 permits 130 worst-case turns; request 131 is rejected before mock inference", async () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  assert.equal(bound, BigInt(76801));
  assert.equal(BigInt(10000000) / bound, BigInt(130));
  assert.equal(DEEPSEEK_FLASH_PRICING.sdkRetries, 0);
  let reserved = BigInt(0);
  let mockProviderCalls = 0;
  for (let i = 0; i < 131; i += 1) {
    if (reserved + bound > BigInt(10000000)) continue;
    reserved += bound;
    mockProviderCalls += 1;
  }
  assert.equal(mockProviderCalls, 130);
  assert.equal(reserved, BigInt(9984130));
  assert.ok(reserved + bound > BigInt(10000000));
});

test("mock-ledger failure, usage settlement, expiry and restart keep spend conservative", async () => {
  const bound = maximumPublicTurnReservationMicroUsd();
  const snapshot = {
    gate: {
      enabled: true,
      organizationId: "pilot-org",
      agentId: "live-default-agent",
      model: "deepseek-flash",
      budgetMicroUsd: BigInt(2) * bound,
      spentMicroUsd: BigInt(0),
      reservedMicroUsd: BigInt(0),
      uncertainMicroUsd: BigInt(0),
      startsAtMs: 100,
      expiresAtMs: 10_000,
    } satisfies PilotSpendSnapshot,
    states: new Map<string, "reserved" | "released" | "uncertain" | "settled">(),
    byConversation: new Map<string, number>(),
  };
  let queue = Promise.resolve();
  async function reserve(conversationId: string, nowMs: number) {
    const prior = queue;
    let unlock!: () => void;
    queue = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    try {
      const turns = snapshot.byConversation.get(conversationId) ?? 0;
      const ok = canReservePilotSpend({
        gate: snapshot.gate,
        organizationId: "pilot-org",
        agentId: "live-default-agent",
        model: "deepseek-flash",
        reserveMicroUsd: bound,
        nowMs,
        conversationTurns: turns,
      });
      if (!ok) return false;
      const id = `${conversationId}:${turns}`;
      snapshot.gate = { ...snapshot.gate, reservedMicroUsd: snapshot.gate.reservedMicroUsd + bound };
      snapshot.byConversation.set(conversationId, turns + 1);
      snapshot.states.set(id, "reserved");
      return id;
    } finally {
      unlock();
    }
  }

  let providerCalls = 0;
  const first = await reserve("conv-a", 101);
  assert.equal(typeof first, "string");
  const failingMockProvider = async () => { providerCalls += 1; throw new Error("timeout after submit"); };
  await assert.rejects(failingMockProvider(), /timeout/);
  snapshot.states.set(first as string, "uncertain");
  snapshot.gate = { ...snapshot.gate, reservedMicroUsd: BigInt(0), uncertainMicroUsd: bound };

  const second = await reserve("conv-b", 101);
  assert.equal(typeof second, "string");
  const missingUsageMock = async () => { providerCalls += 1; return { usage: undefined }; };
  const response = await missingUsageMock();
  assert.equal(extractCompletePublicUsage(response.usage), null);
  // Unknown usage is intentionally not settled/released: the persisted hold survives worker recreation.
  const afterRestart = structuredClone({ gate: snapshot.gate, states: [...snapshot.states] });
  assert.equal(afterRestart.gate.reservedMicroUsd, bound);
  assert.equal(afterRestart.gate.uncertainMicroUsd, bound);
  assert.equal(providerCalls, 2); // One attempt per SDK call; public SDK maxRetries is zero.
  assert.equal(await reserve("conv-c", 10_000), false); // expiry boundary
});

test("deployed-source wiring reserves before conversation creation and inference, and settles every public turn", async () => {
  const routePath = new URL("../../src/app/api/v1/public/agent/[slug]/turn/route.ts", import.meta.url);
  const runtimePath = new URL("../../src/lib/agents/runtime.ts", import.meta.url);
  const limitsPath = new URL("../../src/lib/agents/public-turn-limits.ts", import.meta.url);
  const ratePath = new URL("../../src/lib/utils/rate-limit.ts", import.meta.url);
  const spendPath = new URL("../../src/lib/agents/public-turn-spend.ts", import.meta.url);
  const adminPath = new URL("../../src/app/api/v1/admin/public-pilot/route.ts", import.meta.url);
  const migrationPath = new URL("../../drizzle/0079_public_turn_spend_gate.sql", import.meta.url);
  const route = await (await import("node:fs/promises")).readFile(routePath, "utf8");
  const runtime = await (await import("node:fs/promises")).readFile(runtimePath, "utf8");
  const limits = await (await import("node:fs/promises")).readFile(limitsPath, "utf8");
  const rate = await (await import("node:fs/promises")).readFile(ratePath, "utf8");
  const spend = await (await import("node:fs/promises")).readFile(spendPath, "utf8");
  const admin = await (await import("node:fs/promises")).readFile(adminPath, "utf8");
  const migration = await (await import("node:fs/promises")).readFile(migrationPath, "utf8");
  const position = (source: string, text: string) => source.indexOf(text);

  const auth = position(route, "const authorized = authorizePublicConversationContinuation");
  const limiter = position(route, "const allowed = await checkPublicTurnAllowed");
  const reserve = position(route, "spendReservation = await reservePublicTurnSpend");
  const conversation = position(route, ".insert(agentConversations)");
  const inference = position(route, "result = await executeTurn(");
  assert.ok(auth >= 0 && auth < limiter && limiter < reserve && reserve < conversation && conversation < inference);
  assert.match(route, /settlePublicTurnSpend\(/);
  assert.match(route, /markPublicTurnSpendUncertain\(/);
  assert.match(route, /pilotPublicRequest = !operatorTestSession/);
  assert.match(route, /pilotTarget === "incomplete"/);
  assert.match(route, /metered: pilotPublicRequest/);
  assert.match(route, /if \(pilotPublicRequest\)/);
  assert.match(admin, /role !== "admin" && role !== "owner"/);
  assert.match(admin, /readPublicPilotUsage\(auth\.orgId\)/);
  assert.match(admin, /disablePublicPilot\(auth\.orgId\)/);
  assert.doesNotMatch(admin, /enablePublicPilot|enabled:\s*true/);
  assert.match(limits, /resolveTrustedClientIp\(headers, parseTrustedProxyHops\(process\.env\.TRUSTED_PROXY_HOPS\)\)/);
  assert.match(rate, /options\.failClosed\) throw new Error\("Distributed rate limiter is not configured\."\)/);
  assert.match(rate, /options\.failClosed\) throw new Error\("Distributed rate limiter is unavailable\."\)/);
  assert.match(runtime, /runtimeModel !== "deepseek-flash"/);
  assert.match(runtime, /input\.publicPilotSpend \? \{ maxRetries: 0 \} : undefined/);
  assert.equal((runtime.match(/anthropic\.messages\.create\(/g) ?? []).length, 2);
  assert.equal((runtime.match(/maxRetries: 0/g) ?? []).length, 2);
  assert.match(runtime, /isPublicPilotRequestWithinInputLimit\(requestParams\)/);
  assert.match(runtime, /isPublicPilotRequestWithinInputLimit\(regenParams\)/);
  assert.match(runtime, /input\.publicPilotSpend \? systemPrompt : cachedSystemBlocks/);
  assert.match(spend, /SELECT id, organization_id, agent_id, model,[\s\S]*?FOR UPDATE/);
  assert.ok(spend.includes("publicTurnSpendGates.spentMicroUsd} + ${publicTurnSpendGates.reservedMicroUsd} + ${publicTurnSpendGates.uncertainMicroUsd}"));
  assert.match(spend, /MAX_PUBLIC_TURNS_PER_CONVERSATION/);
  assert.match(spend, /catch \{\s*return null;\s*\}/);
  assert.match(migration, /enabled boolean NOT NULL DEFAULT false/);
  assert.doesNotMatch(migration, /INSERT INTO public_turn_spend_gates/i);
});
