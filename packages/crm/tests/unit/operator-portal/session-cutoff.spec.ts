import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isOperatorTokenRevoked,
  isSupportSessionContext,
} from "../../../src/lib/operator-portal/session";

describe("operator support session cutoff", () => {
  const cutoff = new Date("2026-10-24T10:00:00.000Z");
  const base = { orgId: "tenant-id", email: "operator@example.test", kind: "session" as const, exp: cutoff.getTime() + 2 * 60 * 60 * 1000, supportOriginUserId: "operator-id" };

  test("revokes a token issued at or before the tenant cutoff", () => {
    assert.equal(isOperatorTokenRevoked({ ...base, iat: cutoff.getTime() }, cutoff), true);
    assert.equal(isOperatorTokenRevoked({ ...base, iat: cutoff.getTime() - 1 }, cutoff), true);
    assert.equal(isOperatorTokenRevoked({ ...base, iat: cutoff.getTime() + 1 }, cutoff), false);
  });

  test("dates pre-cutoff tokens without iat from the support token TTL", () => {
    const legacy = { orgId: "tenant-id", email: "operator@example.test", kind: "session" as const, supportOriginUserId: "operator-id", exp: cutoff.getTime() + 2 * 60 * 60 * 1000 };
    assert.equal(isOperatorTokenRevoked(legacy, cutoff), true);
  });

  test("all impersonated support contexts are barred from agent authority, including legacy agency tokens", () => {
    assert.equal(isSupportSessionContext({ supportOriginUserId: "operator-id", supportSessionId: "audit-id" }), true);
    assert.equal(isSupportSessionContext({ supportOriginUserId: "operator-id", supportSessionId: null }), true);
    assert.equal(isSupportSessionContext({ supportOriginUserId: "operator-id" }), true);
    assert.equal(isSupportSessionContext({ supportOriginUserId: null, supportSessionId: null }), false);
    assert.equal(isSupportSessionContext(null), false);
  });
});
