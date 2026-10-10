import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistedChatwootConversationId,
  RELAY_CONTEXT_BINDING_KEY,
  readRelayContextKey,
  sameRelayBinding,
  verifyRelayContext,
  type RelayContextExpected,
} from "../../../src/lib/agents/mcp/relay-context";

test("current Chatwoot conversation id comes from the persisted server binding", () => {
  assert.equal(persistedChatwootConversationId({
    [RELAY_CONTEXT_BINDING_KEY]: { chatwootConversationId: "41" },
  }), "41");
  assert.equal(persistedChatwootConversationId({
    [RELAY_CONTEXT_BINDING_KEY]: { chatwootConversationId: "41x" },
  }), undefined);
  assert.equal(persistedChatwootConversationId({}), undefined);
  assert.equal(persistedChatwootConversationId(null), undefined);
});

const KEY = "synthetic-uplink-relay-context-key-material-only";
const MESSAGE = "I want to start Personal Line.";
const CLAIMS = {
  kid: "ctx1",
  accountId: 2,
  inboxId: 11,
  workspaceId: "2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8",
  agentId: "a5e7235d-9fe1-409a-b824-d7810fc13ab1",
  agentSlug: "uplinks-workspace-4816--default",
  sessionId: "cw-chatwoot-2-41",
  uplinkConversationId: null,
  chatwootConversationId: "41",
  chatwootMessageId: "7001",
  messageSha256: createHash("sha256").update(MESSAGE).digest("hex"),
  plAssertion: "v1.synthetic-pl-assertion",
  iat: 1_797_000_000,
  nonce: randomBytes(16).toString("base64url"),
};
const EXPECTED: RelayContextExpected = {
  accountId: 2,
  inboxId: 11,
  workspaceId: CLAIMS.workspaceId,
  agentId: CLAIMS.agentId,
  agentSlug: CLAIMS.agentSlug,
  sessionId: CLAIMS.sessionId,
  uplinkConversationId: null,
};

function sign(claims: Record<string, unknown>, key = KEY): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${encoded}`).digest("base64url");
  return `v1.${encoded}.${sig}`;
}

function check(token: unknown, overrides: Partial<RelayContextExpected> = {}, nowSec = CLAIMS.iat) {
  return verifyRelayContext({
    token,
    key: KEY,
    kid: "ctx1",
    nowMs: nowSec * 1000,
    message: MESSAGE,
    expected: { ...EXPECTED, ...overrides },
  });
}

test("valid short-lived relay envelope verifies against the native route and visitor message", () => {
  const result = check(sign(CLAIMS));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.claims.plAssertion, CLAIMS.plAssertion);
  assert.equal(result.binding.chatwootConversationId, "41");
  assert.equal("wa_id" in result.claims, false, "source identity is inside the concierge assertion, not duplicated");
});

test("HMAC, message digest, age and exact workspace/agent/session/conversation scope fail closed", () => {
  const token = sign(CLAIMS);
  assert.equal(check(`${token.slice(0, -1)}x`).ok, false);
  assert.equal(check(token, {}, CLAIMS.iat + 61).ok, false);
  assert.equal(verifyRelayContext({ token, key: KEY, kid: "ctx1", nowMs: CLAIMS.iat * 1000, message: "different message", expected: EXPECTED }).ok, false);
  for (const scope of [
    { accountId: 3 }, { inboxId: 12 }, { workspaceId: "foreign-workspace" },
    { agentId: "b5e7235d-9fe1-409a-b824-d7810fc13ab1" },
    { agentSlug: "another-agent" }, { sessionId: "visitor-b-session" },
    { uplinkConversationId: "b5e7235d-9fe1-409a-b824-d7810fc13ab1" },
  ]) assert.equal(check(token, scope).ok, false);
});

test("continuation token must identify the same Uplink and Chatwoot conversation/message", () => {
  const claims = { ...CLAIMS, uplinkConversationId: "b5e7235d-9fe1-409a-b824-d7810fc13ab1", chatwootMessageId: "7002" };
  const expected = { ...EXPECTED, uplinkConversationId: claims.uplinkConversationId, chatwootConversationId: "41", chatwootMessageId: "7002" };
  const token = sign(claims);
  assert.equal(verifyRelayContext({ token, key: KEY, kid: "ctx1", nowMs: CLAIMS.iat * 1000, message: MESSAGE, expected }).ok, true);
  assert.equal(verifyRelayContext({ token, key: KEY, kid: "ctx1", nowMs: CLAIMS.iat * 1000, message: MESSAGE, expected: { ...expected, chatwootConversationId: "42" } }).ok, false);
  assert.equal(verifyRelayContext({ token, key: KEY, kid: "ctx1", nowMs: CLAIMS.iat * 1000, message: MESSAGE, expected: { ...expected, chatwootMessageId: "7003" } }).ok, false);
  assert.equal(verifyRelayContext({ token, key: KEY, kid: "ctx1", nowMs: CLAIMS.iat * 1000, message: MESSAGE, expected: { ...expected, uplinkConversationId: "c5e7235d-9fe1-409a-b824-d7810fc13ab1" } }).ok, false);
});

test("persisted non-secret Chatwoot binding prevents a signed context moving between conversations", () => {
  const result = check(sign(CLAIMS));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(sameRelayBinding(result.binding, { ...result.binding }), true);
  assert.equal(sameRelayBinding({ ...result.binding, chatwootConversationId: "42" }, result.binding), false);
  assert.equal(sameRelayBinding({ ...result.binding, sessionId: "other-session" }, result.binding), false);
});

test("protected context-key file is read without exposing its value; missing/short files return unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uplink-relay-context-"));
  const path = join(dir, "relay.key");
  try {
    await writeFile(path, KEY, { encoding: "utf8", mode: 0o600 });
    const loaded = await readRelayContextKey({ UPLINK_RELAY_CONTEXT_KEY_FILE: path, UPLINK_RELAY_CONTEXT_KEY_ID: "ctx1" });
    assert.deepEqual(loaded, { kid: "ctx1", key: KEY });
    const shortPath = join(dir, "short.key");
    await writeFile(shortPath, "short");
    assert.equal(await readRelayContextKey({ UPLINK_RELAY_CONTEXT_KEY_FILE: shortPath, UPLINK_RELAY_CONTEXT_KEY_ID: "ctx1" }), null);
    assert.equal(await readRelayContextKey({ UPLINK_RELAY_CONTEXT_KEY_FILE: join(dir, "missing"), UPLINK_RELAY_CONTEXT_KEY_ID: "ctx1" }), null);
    const fileText = await readFile(path, "utf8");
    assert.equal(fileText, KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
