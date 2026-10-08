import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  authorizePublicConversationContinuation,
  isPublicConversationCapabilityValid,
  issuePublicConversationCapability,
  isValidAnonymousSessionId,
  isValidPublicConversationId,
  resolvePublicConversationSecret,
} from "../../src/lib/agents/public-conversation-capability";

const secret = "synthetic-auth-secret-that-is-never-used-outside-tests";
const agentId = "agent-live-default";
const organizationId = "workspace-personal-line";
const visitorA = "anon-visitor-a-session-0001";
const visitorB = "anon-visitor-b-session-0002";
const conversationA = "11111111-1111-4111-8111-111111111111";
const conversationB = "22222222-2222-4222-8222-222222222222";

function scope(conversationId: string, anonymousSessionId: string) {
  return { conversationId, organizationId, agentId, anonymousSessionId };
}

test("same live agent: each visitor capability is bound to its own conversation and session", () => {
  const a = scope(conversationA, visitorA);
  const b = scope(conversationB, visitorB);
  const tokenA = issuePublicConversationCapability(a, secret, 1_800_000_000_000);
  const tokenB = issuePublicConversationCapability(b, secret, 1_800_000_000_000);

  assert.equal(isPublicConversationCapabilityValid(tokenA, a, secret, 1_800_000_001_000), true);
  assert.equal(isPublicConversationCapabilityValid(tokenB, b, secret, 1_800_000_001_000), true);
  assert.equal(isPublicConversationCapabilityValid(tokenB, a, secret, 1_800_000_001_000), false);
  assert.equal(isPublicConversationCapabilityValid(tokenA, b, secret, 1_800_000_001_000), false);
});

test("visitor A cannot continue or retrieve visitor B conversation; rejection precedes writes and provider", async () => {
  const a = scope(conversationA, visitorA);
  const b = scope(conversationB, visitorB);
  const tokenA = issuePublicConversationCapability(a, secret, 1_800_000_000_000);
  const tokenB = issuePublicConversationCapability(b, secret, 1_800_000_000_000);
  let turnsCreated = 0;
  let modelCalls = 0;

  async function mockTurn(request: typeof a, capability: unknown, row: typeof b) {
    const authorized = authorizePublicConversationContinuation({
      row,
      request,
      capability,
      secret,
      nowMs: 1_800_000_001_000,
    });
    if (!authorized) return { status: 404 };
    turnsCreated += 1;
    modelCalls += 1;
    return { status: 200 };
  }

  const rejected = [
    { request: a, capability: tokenA, row: b },
    { request: a, capability: undefined, row: b },
    { request: { ...b, anonymousSessionId: visitorA }, capability: tokenB, row: b },
    { request: { ...b, agentId: "sibling-agent" }, capability: tokenB, row: b },
    { request: { ...b, organizationId: "foreign-workspace" }, capability: tokenB, row: b },
  ];
  for (const attempt of rejected) {
    assert.deepEqual(await mockTurn(attempt.request, attempt.capability, attempt.row), { status: 404 });
  }
  assert.equal(turnsCreated, 0);
  assert.equal(modelCalls, 0);

  assert.deepEqual(await mockTurn(a, tokenA, a), { status: 200 });
  assert.equal(turnsCreated, 1);
  assert.equal(modelCalls, 1);
});

test("missing, malformed, mismatched, expired and wrong-secret capabilities fail closed", () => {
  const owner = scope(conversationA, visitorA);
  const token = issuePublicConversationCapability(owner, secret, 1_800_000_000_000);
  const [version, claims, signature] = token.split(".");
  const first = signature[0];
  const tampered = `${version}.${claims}.${(first === "A" ? "B" : "A")}${signature.slice(1)}`;
  const nonObjectClaims = `v1.${Buffer.from("null").toString("base64url")}.${"A".repeat(43)}`;

  for (const bad of [undefined, null, "", "not.a.capability", tampered, nonObjectClaims]) {
    assert.equal(isPublicConversationCapabilityValid(bad, owner, secret, 1_800_000_001_000), false);
  }
  assert.equal(isPublicConversationCapabilityValid(token, owner, "different-secret", 1_800_000_001_000), false);
  assert.equal(isPublicConversationCapabilityValid(token, owner, secret, 1_800_100_000_000), false);
  assert.equal(isPublicConversationCapabilityValid(token, { ...owner, conversationId: conversationB }, secret), false);
  assert.equal(isPublicConversationCapabilityValid(token, { ...owner, anonymousSessionId: visitorB }, secret), false);
});

test("continuation gate retains workspace and sibling-agent isolation", () => {
  const owner = scope(conversationA, visitorA);
  const token = issuePublicConversationCapability(owner, secret);

  assert.equal(authorizePublicConversationContinuation({ row: owner, request: owner, capability: token, secret }), true);
  assert.equal(authorizePublicConversationContinuation({
    row: owner,
    request: { ...owner, agentId: "sibling-agent" },
    capability: token,
    secret,
  }), false);
  assert.equal(authorizePublicConversationContinuation({
    row: owner,
    request: { ...owner, organizationId: "foreign-workspace" },
    capability: token,
    secret,
  }), false);
});

test("missing, malformed and mismatched visitor session identifiers are rejected", () => {
  const owner = scope(conversationA, visitorA);
  const token = issuePublicConversationCapability(owner, secret);
  assert.equal(isValidAnonymousSessionId(undefined), false);
  assert.equal(isValidAnonymousSessionId("bad session value"), false);
  assert.equal(isValidAnonymousSessionId("x".repeat(129)), false);
  assert.equal(isValidPublicConversationId(conversationA), true);
  assert.equal(isValidPublicConversationId("not-a-uuid"), false);
  assert.equal(isValidPublicConversationId(undefined), false);
  assert.equal(authorizePublicConversationContinuation({
    row: owner,
    request: { ...owner, anonymousSessionId: visitorB },
    capability: token,
    secret,
  }), false);
});

test("native Auth.js secret resolution fails closed when absent", () => {
  assert.equal(resolvePublicConversationSecret({}), null);
  assert.equal(resolvePublicConversationSecret({ AUTH_SECRET: "  " }), null);
  assert.equal(resolvePublicConversationSecret({ AUTH_SECRET: "auth", NEXTAUTH_SECRET: "legacy" }), "auth");
  assert.equal(resolvePublicConversationSecret({ NEXTAUTH_SECRET: "legacy" }), "legacy");
});

test("the real public route gates continuations before writes/provider and the embed transports its capability", () => {
  const route = readFileSync(
    path.resolve(__dirname, "../../src/app/api/v1/public/agent/[slug]/turn/route.ts"),
    "utf8",
  );
  const embed = readFileSync(
    path.resolve(__dirname, "../../src/app/api/v1/public/agent/[slug]/embed.js/route.ts"),
    "utf8",
  );
  const gate = route.indexOf("const authorized = authorizePublicConversationContinuation");
  const rateLimit = route.indexOf("const allowed = await checkPublicTurnAllowed");
  const conversationInsert = route.indexOf(".insert(agentConversations)");
  const modelExecution = route.indexOf("await executeTurn(");

  assert.ok(gate >= 0 && gate < rateLimit);
  assert.ok(rateLimit < conversationInsert);
  assert.ok(conversationInsert < modelExecution);
  assert.match(route, /if \(!authorized\)\s*\{[\s\S]*?status: 404/);
  assert.match(embed, /conversation_capability: conversationCapability/);
  assert.match(embed, /json\.conversation_capability/);
});
