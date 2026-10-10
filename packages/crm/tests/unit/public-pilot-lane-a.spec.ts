import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PUBLIC_CHAT_CONVERSATION_LIMIT_MESSAGE,
  PUBLIC_CHAT_UNAVAILABLE_MESSAGE,
} from "../../src/lib/agents/public-pilot-controls";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("pilot refusal copy is truthful: no 'try again', no promise of an instant answer, names the real support line", () => {
  for (const message of [PUBLIC_CHAT_UNAVAILABLE_MESSAGE, PUBLIC_CHAT_CONVERSATION_LIMIT_MESSAGE]) {
    assert.match(message, /\+1 767 818 0001/);
    assert.doesNotMatch(message, /try again|something went wrong|hiccup|someone will/i);
  }
  assert.match(PUBLIC_CHAT_UNAVAILABLE_MESSAGE, /Monday to Saturday, 8:00 am to 6:00 pm Dominica time/);
});

test("every pilot 503 body carries a visitor-facing message (the widget shows a generic 'try again' when none is sent)", () => {
  const route = read("src/app/api/v1/public/agent/[slug]/turn/route.ts");
  const bodies = route.match(/\{ error: "(?:PUBLIC_CHAT_UNAVAILABLE|temporarily_unavailable)"[^}]*\}/g) ?? [];
  assert.ok(bodies.length >= 4, `expected at least 4 refusal bodies, found ${bodies.length}`);
  for (const body of bodies) assert.match(body, /message: PUBLIC_CHAT_UNAVAILABLE_MESSAGE/);
  assert.match(route, /PUBLIC_CHAT_CONVERSATION_LIMIT_MESSAGE/);
  assert.match(route, /publicConversationAtLimit\(conversationId\)/);
});

test("a distributed limiter (Redis) is NOT required for the pilot unless the operator opts in", () => {
  const spend = read("src/lib/agents/public-turn-spend.ts");
  const route = read("src/app/api/v1/public/agent/[slug]/turn/route.ts");
  assert.match(spend, /PUBLIC_PILOT_REQUIRE_DISTRIBUTED_LIMITER !== "1"/);
  assert.match(route, /failClosed: pilotPublicRequest && process\.env\.PUBLIC_PILOT_REQUIRE_DISTRIBUTED_LIMITER === "1"/);
  assert.doesNotMatch(spend, /process\.env\.UPSTASH_REDIS_REST_URL\?\.trim\(\) &&\s*\n\s*process\.env\.UPSTASH_REDIS_REST_TOKEN\?\.trim\(\) &&\s*\n\s*parseTrustedProxyHops/);
});

test("the migration is a single block that matches the drizzle schema (no duplicated or conflicting DDL)", () => {
  const sqlText = read("drizzle/0079_public_turn_spend_gate.sql");
  assert.equal((sqlText.match(/CREATE TABLE IF NOT EXISTS public_turn_spend_gates/g) ?? []).length, 1);
  assert.equal((sqlText.match(/CREATE TABLE IF NOT EXISTS public_turn_spend_reservations/g) ?? []).length, 1);
  assert.match(sqlText, /conversation_id uuid,/);
  assert.match(sqlText, /enabled boolean NOT NULL DEFAULT false/);
  assert.doesNotMatch(sqlText, /INSERT INTO/i, "the migration must not seed or enable a gate row");
});

test("the kill switch compares the Origin HOST with the Host the browser addressed (nextUrl.origin is the container's http origin behind the ingress)", () => {
  const admin = read("src/app/api/v1/admin/public-pilot/route.ts");
  assert.doesNotMatch(admin, /nextUrl\.origin/);
  assert.match(admin, /x-forwarded-host/);
  assert.match(admin, /originHost === hostHeader/);
  assert.match(admin, /isSameOriginRequest\(request\)/);
});

test("a typo in the pilot environment cannot leave the pilot agent public and unmetered: a database gate row forces fail-closed", () => {
  const route = read("src/app/api/v1/public/agent/[slug]/turn/route.ts");
  const spend = read("src/lib/agents/public-turn-spend.ts");
  assert.match(route, /pilotTarget === "other" && \(await agentHasPilotGate\(agentRow\.id\)\)\) pilotTarget = "incomplete"/);
  // organization-level coverage: the gate row is found through the agent's workspace, so every agent of the pilot workspace fails closed too
  assert.match(spend, /FROM public_turn_spend_gates g JOIN agents a ON a\.org_id = g\.organization_id WHERE a\.id = \$\{agentId\}::uuid LIMIT 1/);
  // the in-transaction reservation no longer requires the gate row's agent to equal the requesting agent, but still requires the workspace
  assert.doesNotMatch(spend, /gate\.agent_id !== input\.agentId/);
  assert.match(spend, /gate\.organization_id !== input\.organizationId/);
});
