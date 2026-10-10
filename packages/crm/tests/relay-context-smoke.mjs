import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createMcpClient } from "../src/lib/agents/mcp/client.ts";
import { verifyRelayContext } from "../src/lib/agents/mcp/relay-context.ts";

const key = "offline-synthetic-uplink-context-key-material-only";
const message = "I want Personal Line.";
const claims = {
  kid: "ctx1", accountId: 2, inboxId: 11,
  workspaceId: "2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8",
  agentId: "a5e7235d-9fe1-409a-b824-d7810fc13ab1",
  agentSlug: "uplinks-workspace-4816--default", sessionId: "cw-chatwoot-2-41",
  uplinkConversationId: null, chatwootConversationId: "41", chatwootMessageId: "7001",
  messageSha256: createHash("sha256").update(message).digest("hex"),
  plAssertion: "v1.synthetic-assertion", iat: 1_797_000_000,
  nonce: randomBytes(16).toString("base64url"),
};
const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
const proof = `v1.${encoded}.${createHmac("sha256", key).update(`v1.${encoded}`).digest("base64url")}`;
const expected = {
  accountId: 2, inboxId: 11, workspaceId: claims.workspaceId, agentId: claims.agentId,
  agentSlug: claims.agentSlug, sessionId: claims.sessionId, uplinkConversationId: null,
};

assert.equal(verifyRelayContext({ token: proof, key, kid: "ctx1", nowMs: claims.iat * 1000, message, expected }).ok, true);
assert.equal(verifyRelayContext({ token: proof, key, kid: "ctx1", nowMs: claims.iat * 1000, message: "changed", expected }).ok, false);
assert.equal(verifyRelayContext({ token: proof, key, kid: "ctx1", nowMs: claims.iat * 1000, message, expected: { ...expected, agentId: "b5e7235d-9fe1-409a-b824-d7810fc13ab1" } }).ok, false);
assert.equal(verifyRelayContext({ token: proof, key, kid: "ctx1", nowMs: (claims.iat + 61) * 1000, message, expected }).ok, false);

const calls = [];
const fetchImpl = async (_url, init) => {
  const body = JSON.parse(String(init.body));
  calls.push(body);
  return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: {} });
};
const client = createMcpClient({ endpoint: "https://actions.epic.dm/mcp", bearer: "synthetic-workspace-token", fetchImpl });
await client.callTool("personal_line__offer", {}, { "com.epic.uplink/relay-context-v1": proof });
const toolCall = calls.find((call) => call.method === "tools/call");
assert.deepEqual(toolCall.params.arguments, {});
assert.deepEqual(toolCall.params._meta, { "com.epic.uplink/relay-context-v1": proof });
assert.equal(JSON.stringify(toolCall.params.arguments).includes(proof), false);
console.log("native relay-context smoke: 7 assertions passed");
