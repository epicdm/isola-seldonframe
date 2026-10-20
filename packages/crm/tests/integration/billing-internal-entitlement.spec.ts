// EPIC 2026-10-20 — the billing page's internal-entitlement reader against a REAL Postgres through the production driver, after the
// REAL audited entitlement action and the REAL reversal script ran. Display only: nothing in the reader writes.
// Port plan-epic-execution-control-current-2026-10-20 (billing gap 5b). Scratch database only; all fixtures are synthetic; ids and
// emails differ from the other specs' (users.email is unique and the specs can share one scratch database).
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const SUPER = "a5000000-0000-4000-8000-000000000001";
const INTERNAL_WS = "b5000000-0000-4000-8000-000000000001"; // gets the internal entitlement
const PAID_WS = "b5000000-0000-4000-8000-000000000002"; // a normal Stripe-managed workspace
const SUPER_EMAIL = "ops-billing@platform.test";
const superActor = { userId: SUPER, email: SUPER_EMAIL };

describe("billing internal-entitlement reader (scratch Postgres, production driver)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let T: typeof import("@/lib/workspace/transfer-ownership");
  let B: typeof import("@/lib/billing/internal-entitlement");
  let getOrgSubscription: typeof import("@/lib/billing/subscription").getOrgSubscription;
  const revertSql = readFileSync(path.resolve("scripts/ops/revert-internal-entitlement.sql"), "utf8");
  const block = revertSql.slice(revertSql.indexOf("DO $revert$"));
  const count = async (q: ReturnType<typeof sql>) => {
    const r = await db.execute(q);
    const rows = ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as { n: string }[];
    return Number(rows[0].n);
  };
  const revert = async (ent: string) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('epic_revert.org', ${INTERNAL_WS}, true), set_config('epic_revert.entitlement_action', ${ent}, true), set_config('epic_revert.actor_id', ${SUPER}, true), set_config('epic_revert.actor_email', ${SUPER_EMAIL}, true)`);
      await tx.execute(sql.raw(block));
    });
  };

  before(async () => {
    process.env.SF_SUPERADMIN_EMAILS = SUPER_EMAIL;
    process.env.AUTH_SECRET = ["fixture", "billing", "secret", "only"].join("-");
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });
    ({ db } = await import("@/db"));
    T = await import("@/lib/workspace/transfer-ownership");
    B = await import("@/lib/billing/internal-entitlement");
    ({ getOrgSubscription } = await import("@/lib/billing/subscription"));
    const ex = (q: ReturnType<typeof sql>) => db.execute(q);
    await ex(sql`insert into organizations (id, name, slug, plan, subscription) values
      (${INTERNAL_WS}::uuid, 'internal', 'bill-internal', 'free', '{}'::jsonb),
      (${PAID_WS}::uuid, 'paid', 'bill-paid', 'workspace', '{"tier":"workspace","status":"active","stripeCustomerId":"cus_fixture","stripeSubscriptionId":"sub_fixture","stripePriceId":"price_fixture_month"}'::jsonb)`);
    await ex(sql`insert into users (id, org_id, name, email, role, plan_id) values (${SUPER}::uuid, ${INTERNAL_WS}::uuid, 'ops', ${SUPER_EMAIL}, 'owner', 'free')`);
    await ex(sql`update organizations set owner_id = ${SUPER}::uuid where id in (${INTERNAL_WS}::uuid, ${PAID_WS}::uuid)`);
  });

  test("never entitled: no record, normal display", async () => {
    assert.equal(await B.findActiveInternalEntitlement(INTERNAL_WS), null);
    assert.equal(await B.findActiveInternalEntitlement(null), null);
  });

  test("a refused entitlement (Stripe-managed workspace) leaves no active record and the paid display", async () => {
    const r = await T.setInternalWorkspaceEntitlement({ orgId: PAID_WS, tier: "growth", actor: superActor });
    assert.deepEqual(r.ok ? "applied" : r.reason, "stripe_managed_subscription");
    assert.equal(await count(sql`select count(*)::text as n from workspace_admin_actions where org_id = ${PAID_WS}::uuid and outcome = 'refused'`), 1, "control: the refusal was recorded");
    const rec = await B.findActiveInternalEntitlement(PAID_WS);
    assert.equal(rec, null);
    const p = B.billingPresentation({ subscription: await getOrgSubscription(PAID_WS), record: rec, tier: "workspace", isGuestAdminToken: false, hasStripeCustomer: true });
    assert.deepEqual(p, { internalPlan: false, showManageSubscription: true });
  });

  test("applied entitlement: the reader returns it and the page shows the internal plan without Manage subscription", async () => {
    const ent = await T.setInternalWorkspaceEntitlement({ orgId: INTERNAL_WS, tier: "growth", actor: superActor });
    assert.equal(ent.ok, true, JSON.stringify(ent));
    if (!ent.ok) return;
    const before = await count(sql`select count(*)::text as n from workspace_admin_actions`);
    const rec = await B.findActiveInternalEntitlement(INTERNAL_WS);
    assert.deepEqual(rec, { actionId: ent.actionId, tier: "growth", paymentCollection: "off" });
    const sub = await getOrgSubscription(INTERNAL_WS);
    assert.deepEqual(B.billingPresentation({ subscription: sub, record: rec, tier: "workspace", isGuestAdminToken: false, hasStripeCustomer: false }), { internalPlan: true, showManageSubscription: false });
    assert.equal(await count(sql`select count(*)::text as n from workspace_admin_actions`), before, "the reader writes nothing");

    // Reversed by the real script: the record no longer applies and the display falls back.
    await revert(ent.actionId);
    assert.equal(await B.findActiveInternalEntitlement(INTERNAL_WS), null);
    const after = await getOrgSubscription(INTERNAL_WS);
    assert.equal(B.isInternalEntitlementInEffect(after, null), false);
  });

  test("re-entitled after a reversal: the newer unreverted record is the one read", async () => {
    const again = await T.setInternalWorkspaceEntitlement({ orgId: INTERNAL_WS, tier: "growth", actor: superActor });
    assert.equal(again.ok, true, JSON.stringify(again));
    if (!again.ok) return;
    const rec = await B.findActiveInternalEntitlement(INTERNAL_WS);
    assert.equal(rec?.actionId, again.actionId);
  });
});
