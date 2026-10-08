import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/turn/route.ts"),
  "utf8",
);

describe("public turn route: a supplied conversation_id must belong to the requested agent and workspace", () => {
  test("the ownership lookup constrains the conversation id, the agent id AND the org id", () => {
    assert.match(source, /eq\(agentConversations\.id, conversationId\)/);
    assert.match(source, /eq\(agentConversations\.agentId, agentRow\.id\)/);
    assert.match(source, /eq\(agentConversations\.orgId, agentRow\.orgId\)/);
  });

  test("a conversation that is not owned is rejected with 404 conversation_not_found", () => {
    assert.match(source, /conversation_not_found/);
    assert.match(source, /conversation_not_found[\s\S]{0,120}status: 404/);
  });

  test("a malformed id is rejected before it reaches the database (uuid column)", () => {
    assert.match(source, /isUuid\(conversationId\)/);
  });

  test("the ownership check runs BEFORE any turn is executed (stream and JSON paths)", () => {
    const check = source.indexOf("conversation_not_found");
    const firstExecute = source.indexOf("executeTurn(");
    assert.ok(check > 0, "ownership check missing");
    assert.ok(firstExecute > 0, "executeTurn call missing");
    assert.ok(check < firstExecute, "ownership check must precede executeTurn");
  });
});
