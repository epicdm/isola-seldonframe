// EPIC 2026-10-20 — operator-portal session cut-off and platform-admin-only authority (pure rules; no database).
// Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20. The route-level proof is
// tests/integration/workspace-ownership-transfer.spec.ts.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  OPERATOR_MAGIC_LINK_TTL_MS,
  OPERATOR_SESSION_TTL_MS,
  OPERATOR_SUPPORT_SESSION_TTL_MS,
  OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS,
  isOperatorTokenRevoked,
  operatorTokenIssuedAt,
} from "../../../src/lib/operator-portal/session";
import { isAuthorizedOnlyAsPlatformAdmin } from "../../../src/lib/operator-portal/authorization";

const NOW = Date.UTC(2026, 9, 20, 2, 0, 0);
const CUTOFF = new Date(NOW - 60_000);
const T = CUTOFF.getTime();

describe("operatorTokenIssuedAt", () => {
  test("uses iat when present", () => {
    assert.equal(operatorTokenIssuedAt({ kind: "session", exp: T + 1, iat: T - 5 }), T - 5);
  });
  test("derives legacy tokens (no iat) from exp minus the TTL of their kind", () => {
    assert.equal(operatorTokenIssuedAt({ kind: "magic", exp: T + OPERATOR_MAGIC_LINK_TTL_MS }), T);
    assert.equal(operatorTokenIssuedAt({ kind: "session", exp: T + OPERATOR_SESSION_TTL_MS }), T);
    assert.equal(operatorTokenIssuedAt({ kind: "session", exp: T + OPERATOR_SUPPORT_SESSION_TTL_MS, supportOriginUserId: "u" }), T);
  });
});

describe("isOperatorTokenRevoked: rule is issuedAt <= validAfter", () => {
  for (const [label, iat, revoked] of [
    ["issued exactly AT the cut-off is revoked", T, true],
    ["issued 1 ms BEFORE the cut-off is revoked", T - 1, true],
    ["issued 1 ms AFTER the cut-off is accepted", T + 1, false],
  ] as const) {
    test(label, () => {
      assert.equal(isOperatorTokenRevoked({ kind: "session", exp: iat + OPERATOR_SESSION_TTL_MS, iat }, CUTOFF, NOW), revoked);
    });
  }
  test("the same boundaries hold for legacy tokens dated from exp", () => {
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: T + OPERATOR_SESSION_TTL_MS }, CUTOFF, NOW), true);
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: T + 1 + OPERATOR_SESSION_TTL_MS }, CUTOFF, NOW), false);
    assert.equal(isOperatorTokenRevoked({ kind: "magic", exp: T - 1 + OPERATOR_MAGIC_LINK_TTL_MS }, CUTOFF, NOW), true);
  });
  test("no cut-off: nothing is revoked (positive control)", () => {
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: T + OPERATOR_SESSION_TTL_MS, iat: T }, null, NOW), false);
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: T + OPERATOR_SESSION_TTL_MS, iat: T }, undefined, NOW), false);
  });
  test("a string cut-off (as read from the database) is honoured", () => {
    assert.equal(isOperatorTokenRevoked({ kind: "magic", exp: T + 1, iat: T }, CUTOFF.toISOString(), NOW), true);
  });
  test("clock skew: a token dated more than the allowed skew into the future is refused; within it, accepted", () => {
    const within = NOW + OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS;
    const beyond = NOW + OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS + 1;
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: within + 10, iat: within }, CUTOFF, NOW), false);
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: beyond + 10, iat: beyond }, CUTOFF, NOW), true);
  });
  test("an unparseable cut-off fails closed", () => {
    assert.equal(isOperatorTokenRevoked({ kind: "session", exp: NOW + 10, iat: NOW }, "not-a-date", NOW), true);
  });
});

describe("isAuthorizedOnlyAsPlatformAdmin", () => {
  const admin = "ops@platform.test";
  test("an allowlisted email with no tenant role is platform-only (refused a standing session)", () => {
    assert.equal(isAuthorizedOnlyAsPlatformAdmin(admin, { adminEmails: [admin] }), true);
    assert.equal(isAuthorizedOnlyAsPlatformAdmin("  OPS@Platform.TEST ", { adminEmails: [admin] }), true);
  });
  test("an allowlisted email that is ALSO owner / agency owner / member keeps tenant authority (positive controls)", () => {
    assert.equal(isAuthorizedOnlyAsPlatformAdmin(admin, { adminEmails: [admin], ownerEmail: admin }), false);
    assert.equal(isAuthorizedOnlyAsPlatformAdmin(admin, { adminEmails: [admin], agencyOwnerEmail: admin }), false);
    assert.equal(isAuthorizedOnlyAsPlatformAdmin(admin, { adminEmails: [admin], memberEmails: [admin] }), false);
  });
  test("a non-admin is never platform-only", () => {
    assert.equal(isAuthorizedOnlyAsPlatformAdmin("owner@tenant.test", { adminEmails: [admin], ownerEmail: "owner@tenant.test" }), false);
    assert.equal(isAuthorizedOnlyAsPlatformAdmin("", { adminEmails: [admin] }), false);
  });
});

// Inventory guard: every place that signs an operator-portal token is one of the three reviewed mint paths. A new mint path must be
// reviewed against the session cut-off and the platform-admin rule before it can pass this test.
describe("operator-portal mint paths", () => {
  test("signOperatorToken is called only from the reviewed mint paths", () => {
    const src = path.resolve(__dirname, "../../../src");
    const calls: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(p, "utf8");
        const n = (text.match(/signOperatorToken\(/g) ?? []).length - (text.match(/export function signOperatorToken\(/g) ?? []).length;
        for (let i = 0; i < n; i++) calls.push(path.relative(src, p).split(path.sep).join("/"));
      }
    };
    walk(src);
    assert.deepEqual(calls.sort(), [
      "lib/operator-portal/auth.ts", // issueOperatorMagicLink (15-min magic link)
      "lib/operator-portal/auth.ts", // consumeOperatorMagicLink (7-day session, tenant authority re-checked)
      "lib/operator-portal/support-session.ts", // the 2-hour audited support session
    ].sort());
  });
});
