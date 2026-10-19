// 2026-10-19 — conversation ownership guard
// (def-uplink-public-turn-conversation-id-not-bound-to-agent-2026-10-19).
//
// The public turn route used a caller-supplied conversation_id without checking
// it belonged to the URL's agent. These tests pin the pure guard, the
// identical not-found result (no existence oracle), and the wiring of the
// route + runtime to the guard.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  conversationMatchesOwner,
  CONVERSATION_NOT_FOUND_RESULT,
} from "../../../src/lib/agents/conversation-ownership";

const AGENT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_B = "22222222-2222-2222-2222-222222222222";
const ORG_X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_Y = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const expected = { agentId: AGENT_A, orgId: ORG_X };

describe("conversationMatchesOwner", () => {
  test("own conversation is accepted (positive control)", () => {
    assert.equal(conversationMatchesOwner({ agentId: AGENT_A, orgId: ORG_X }, expected), true);
  });

  test("another agent's conversation in the same workspace is rejected", () => {
    assert.equal(conversationMatchesOwner({ agentId: AGENT_B, orgId: ORG_X }, expected), false);
  });

  test("a conversation in another workspace is rejected", () => {
    assert.equal(conversationMatchesOwner({ agentId: AGENT_B, orgId: ORG_Y }, expected), false);
  });

  test("agentId and orgId are checked independently (field-distinctness control)", () => {
    // Same agent id but another workspace — only the org check can catch it.
    assert.equal(conversationMatchesOwner({ agentId: AGENT_A, orgId: ORG_Y }, expected), false);
    // Control: the ids under test really differ, so the two cases above are not vacuous.
    assert.notEqual(AGENT_A, AGENT_B);
    assert.notEqual(ORG_X, ORG_Y);
  });

  test("unknown conversation (null) is rejected", () => {
    assert.equal(conversationMatchesOwner(null, expected), false);
    assert.equal(conversationMatchesOwner(undefined, expected), false);
  });

  test("internal callers with no expectation keep pre-fix behaviour", () => {
    assert.equal(conversationMatchesOwner({ agentId: AGENT_B, orgId: ORG_Y }, undefined), true);
    assert.equal(conversationMatchesOwner(null, undefined), false);
  });
});

describe("no existence oracle", () => {
  test("foreign and unknown ids map to the one identical not-found result", () => {
    const forUnknown = conversationMatchesOwner(null, expected) ? null : { ...CONVERSATION_NOT_FOUND_RESULT };
    const forForeign = conversationMatchesOwner({ agentId: AGENT_B, orgId: ORG_Y }, expected)
      ? null
      : { ...CONVERSATION_NOT_FOUND_RESULT };
    assert.ok(forUnknown && forForeign);
    assert.deepEqual(forForeign, forUnknown);
    assert.equal(forUnknown.reason, "conversation_not_found");
    assert.equal(forUnknown.ok, false);
  });
});

describe("wiring (source assertions)", () => {
  const crm = path.resolve(__dirname, "../../..");
  const runtime = readFileSync(path.join(crm, "src/lib/agents/runtime.ts"), "utf8");
  const route = readFileSync(
    path.join(crm, "src/app/api/v1/public/agent/[slug]/turn/route.ts"),
    "utf8",
  );

  test("runtime gates the not-found branch on the ownership guard", () => {
    assert.match(runtime, /if \(!conv \|\| !conversationMatchesOwner\(conv, input\.expectedAgent\)\)/);
    assert.match(runtime, /return \{ \.\.\.CONVERSATION_NOT_FOUND_RESULT \}/);
  });

  test("public route passes expectedAgent from the URL-resolved agent on BOTH turn paths", () => {
    assert.match(route, /const expectedAgent = \{ agentId: agentRow\.id, orgId: agentRow\.orgId \}/);
    const calls = route.match(/executeTurn\(\{[\s\S]*?\}\);/g) ?? [];
    assert.equal(calls.length, 2, "expected exactly two executeTurn calls (SSE + JSON)");
    for (const c of calls) assert.match(c, /expectedAgent/);
  });
});
