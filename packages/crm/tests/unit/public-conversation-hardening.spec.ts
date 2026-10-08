import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isPublicConversationCapabilityValid,
  issuePublicConversationCapability,
} from "../../src/lib/agents/public-conversation-capability";

const scope = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  anonymousSessionId: "anon-test-session-0001",
};
// Generated per run: no secret-looking literal is committed.
const SECRET = randomBytes(32).toString("base64url");
const NOW = 1_800_000_000_000;

describe("capability signing key is domain-separated", () => {
  test("a token signed with the RAW platform secret is rejected (the key is derived, not the secret itself)", () => {
    const issued = issuePublicConversationCapability(scope, SECRET, NOW);
    const [version, claims] = issued.split(".");
    const forged = `${version}.${claims}.${createHmac("sha256", SECRET).update(`${version}.${claims}`).digest("base64url")}`;
    assert.equal(isPublicConversationCapabilityValid(forged, scope, SECRET, NOW), false);
  });

  test("POSITIVE CONTROL: the module's own token verifies, and survives a round trip with the same secret only", () => {
    const issued = issuePublicConversationCapability(scope, SECRET, NOW);
    assert.equal(isPublicConversationCapabilityValid(issued, scope, SECRET, NOW), true);
    assert.equal(isPublicConversationCapabilityValid(issued, scope, SECRET + "x", NOW), false);
  });

  test("the module never uses the raw secret as the HMAC key", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/lib/agents/public-conversation-capability.ts"), "utf8");
    assert.doesNotMatch(source, /createHmac\("sha256", secret\)\s*\.update\(signingInput\)/);
    assert.match(source, /createHmac\("sha256", signingKey\(secret\)\)/);
  });
});

describe("operator test mode is workspace-bound", () => {
  const route = readFileSync(
    path.resolve(__dirname, "../../src/app/api/v1/public/agent/[slug]/turn/route.ts"),
    "utf8",
  );
  test("test mode requires the signed-in user's active workspace to be the agent's workspace", () => {
    assert.match(route, /isAuthenticatedOperator = Boolean\(user\?\.id\) && \(await getOrgId\(\)\) === agentRow\.orgId/);
  });
  test("the bypass is not granted to merely 'any authenticated user'", () => {
    assert.doesNotMatch(route, /isAuthenticatedOperator = Boolean\(user\?\.id\);/);
  });
});

describe("secret-printing vendor debug routes are removed", () => {
  test("/api/auth/debug and /api/auth-debug no longer exist (they printed the last characters of AUTH_SECRET to anonymous callers)", () => {
    assert.equal(existsSync(path.resolve(__dirname, "../../src/app/api/auth/debug/route.ts")), false);
    assert.equal(existsSync(path.resolve(__dirname, "../../src/app/api/auth-debug/route.ts")), false);
  });
});
