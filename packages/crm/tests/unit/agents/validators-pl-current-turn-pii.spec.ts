import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBlueprint } from "../../../src/db/schema/agents";
import type { AgentToolCall, AgentToolResult } from "../../../src/db/schema/agents";
import { runValidators, type ValidatorContext } from "../../../src/lib/agents/validators";

const blueprint: AgentBlueprint = {};
const agentId = "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6";
const workspaceId = "2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8";
const relay = {
  kind: "chatwoot" as const,
  binding: { accountId: 2, inboxId: 11, chatwootConversationId: "8001", workspaceId, agentId, agentSlug: "uplinks-workspace-4816--default", sessionId: "cw-chatwoot-2-8001" },
};
const did = "+1 (767) 555-0199";

function mcpResult(payload: Record<string, unknown>, ok = true): AgentToolResult {
  return { toolCallId: "tool-1", ok, output: { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] } };
}

function pii(response: string, toolName = "pl-action-adapter__pl_provision", result = mcpResult({ code: "line_created", data: { did_pretty: did } }), binding = relay, currentConversationId: string | null = "8001") {
  const ctx: ValidatorContext = {
    response,
    userMessage: "I confirmed the Personal Line offer.",
    blueprint,
    soul: null,
    turnToolCalls: [{ id: "tool-1", name: toolName, input: {} } as AgentToolCall],
    turnToolResults: [result],
    trustedRelayToolContext: binding,
    currentChatwootConversationId: currentConversationId ?? undefined,
    currentAgentId: agentId,
    currentWorkspaceId: workspaceId,
  };
  return { ctx, result: runValidators(ctx).results.find((item) => item.name === "no_pii_leak")! };
}

test("a verified current-turn line result allows only the newly allocated number", () => {
  assert.equal(pii(`Your new number is ${did}.`).result.passed, true);
});

test("third-party PII in the same successful result is not trusted", () => {
  const out = mcpResult({ code: "line_created", data: { did_pretty: did, contact_phone: "+1 767 555 0142", contact_email: "other@example.net" } });
  assert.equal(pii("Your line is ready. Pat's number is +1 767 555 0142 and email other@example.net.", "pl-action-adapter__pl_provision", out).result.passed, false);
});

test("failed, malformed, and other-connector results cannot authorize PII", () => {
  const success = { code: "line_created", data: { did_pretty: did } };
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", mcpResult(success, false)).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "other-connector__pl_provision", mcpResult(success)).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", { toolCallId: "different-call", ok: true, output: success }).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", mcpResult(success), { ...relay, binding: { ...relay.binding, agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b7" } }).result.passed, false);
});

test("only provision/status success codes can authorize the result number", () => {
  const result = mcpResult({ code: "provisioning", data: { did_pretty: did } });
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_status", mcpResult({ code: "line_status", data: { did_pretty: did } })).result.passed, true);
});

test("digit runs inside the exact authorized setup URL are ignored, but a leaked number outside it is not", () => {
  const url = "https://app.epic.dm/go/1234567890abcdef1234567890abcdef";
  const link = mcpResult({ code: "link_minted", data: { url } });
  assert.equal(pii(`Use this setup link: ${url}`, "pl-action-adapter__pl_setup_link", link).result.passed, true);
  assert.equal(pii(`Use this setup link: ${url}. Another customer's number is +1 767 555 0142.`, "pl-action-adapter__pl_setup_link", link).result.passed, false);
  assert.equal(pii("Use https://evil.example/setup/767-555-0142", "pl-action-adapter__pl_setup_link", mcpResult({ code: "link_minted", data: { url: "https://evil.example/setup/767-555-0142" } })).result.passed, false);
  assert.equal(pii("Use this link: https://evil.example/account/767-555-0142", "pl-action-adapter__pl_setup_link", mcpResult({ code: "link_minted", data: { url: "https://evil.example/account/767-555-0142" } })).result.passed, false);
  const queryLeak = `${url}?next=767-555-0142`;
  assert.equal(pii(`Use this link: ${queryLeak}`, "pl-action-adapter__pl_setup_link", mcpResult({ code: "link_minted", data: { url: queryLeak } })).result.passed, false);
});

test("workspace or Chatwoot-conversation mismatch never grants a DID exception", () => {
  const result = mcpResult({ code: "line_created", data: { did_pretty: did } });
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result, {
    ...relay, binding: { ...relay.binding, workspaceId: "other-workspace-id-000000" },
  }).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result, {
    ...relay, binding: { ...relay.binding, chatwootConversationId: "8002" },
  }).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result, relay, "8002").result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result, relay, null).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", result, relay).result.passed, true);
});

test("unrelated successful tool codes and untrusted result fields do not grant an exception", () => {
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_status", mcpResult({
    code: "line_status", data: { did_pretty: did, status: "failed" },
  }, false)).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", mcpResult({
    code: "line_created", data: { customer: { did_pretty: did } },
  })).result.passed, false);
  assert.equal(pii(`Your number is ${did}.`, "pl-action-adapter__pl_provision", mcpResult({
    code: "offer", data: { did_pretty: did },
  })).result.passed, false);
});

test("regeneration reuses the verified current-turn data, without broadening trust", () => {
  const { ctx } = pii(`Your number is ${did}.`);
  const first = runValidators(ctx).results.find((item) => item.name === "no_pii_leak");
  const regenerated = runValidators({ ...ctx, response: `Your number is ${did}; another customer's number is +1 767 555 0142.` }).results.find((item) => item.name === "no_pii_leak");
  assert.equal(first?.passed, true);
  assert.equal(regenerated?.passed, false);
});
