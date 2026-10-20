// EPIC 2026-10-20 — tenant vs reseller scope against a REAL Postgres through the production driver: (1) an internal grant stays
// with the workspace it was granted to (other workspaces of the same owner do not inherit it); paid and agency inheritance are
// unchanged; (2) the authorised-agency display gate; (3) the workspace-creation count boundary.
// Scratch database only; all fixtures synthetic; ids/emails unique to this spec (a6/b6 prefixes).
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const U = (n: number) => `a6000000-0000-4000-8000-00000000000${n}`;
const O = (n: number) => `b6000000-0000-4000-8000-00000000000${n}`;
const SUPER = U(1), TENANT = U(2), PAID = U(3), AGENCY = U(4), PENDING = U(5), WEAK = U(6);
const SUPER_EMAIL = "ops-scope@platform.test";
// TENANT: O(1) primary (internal grant, like EPIC), O(2) second own workspace (like info@'s old home / a newly built one)
// PAID: O(3) primary with a Stripe-paid Workspace subscription, O(4) second own workspace
// AGENCY: O(5) agency billing workspace on a paid agency_scale subscription, O(6) client workspace
// PENDING: O(7) agency workspace (agency_scale) but partner agency status 'pending'
// WEAK: O(8) primary on a paid Workspace (non-agency) plan with an ACTIVE partner agency row
// SUPER: O(9) workspace owned by the platform admin (no plan)
const AG_ACTIVE = "c6000000-0000-4000-8000-000000000001", AG_PENDING = "c6000000-0000-4000-8000-000000000002", AG_WEAK = "c6000000-0000-4000-8000-000000000003";

describe("tenant vs reseller scope (scratch Postgres, production driver)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let T: typeof import("@/lib/workspace/transfer-ownership");
  let R: typeof import("@/lib/billing/tier-resolver");
  let A: typeof import("@/lib/partner-agencies/authorized-agency");
  let C: typeof import("@/lib/web-onboarding/owned-workspace-count");
  let L: typeof import("@/lib/billing/limits");
  const ex = (q: ReturnType<typeof sql>) => db.execute(q);
  const tier = async (org: string) => R.resolveTierForWorkspace(org);
  const revertSql = readFileSync(path.resolve("scripts/ops/revert-internal-entitlement.sql"), "utf8");
  const block = revertSql.slice(revertSql.indexOf("DO $revert$"));
  const paidSub = (t: string) => sql.raw(`'{"tier":"${t}","status":"active","stripeCustomerId":"cus_${t}","stripeSubscriptionId":"sub_${t}","stripePriceId":"price_${t}_month"}'::jsonb`);

  before(async () => {
    process.env.SF_SUPERADMIN_EMAILS = SUPER_EMAIL;
    process.env.AUTH_SECRET = ["fixture", "scope", "secret", "only"].join("-");
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });
    ({ db } = await import("@/db"));
    T = await import("@/lib/workspace/transfer-ownership");
    R = await import("@/lib/billing/tier-resolver");
    A = await import("@/lib/partner-agencies/authorized-agency");
    C = await import("@/lib/web-onboarding/owned-workspace-count");
    L = await import("@/lib/billing/limits");

    for (let n = 1; n <= 9; n++) await ex(sql`insert into organizations (id, name, slug, plan, subscription) values (${O(n)}::uuid, ${"scope-" + n}, ${"scope-ws-" + n}, 'free', '{}'::jsonb)`);
    await ex(sql`update organizations set plan = 'workspace', subscription = ${paidSub("workspace")} where id in (${O(3)}::uuid, ${O(8)}::uuid)`);
    await ex(sql`update organizations set plan = 'agency_scale', subscription = ${paidSub("agency_scale")} where id in (${O(5)}::uuid, ${O(7)}::uuid)`);
    const users: Array<[string, string, string]> = [[SUPER, O(9), SUPER_EMAIL], [TENANT, O(1), "tenant-scope@t.test"], [PAID, O(3), "paid-scope@t.test"], [AGENCY, O(5), "agency-scope@t.test"], [PENDING, O(7), "pending-scope@t.test"], [WEAK, O(8), "weak-scope@t.test"]];
    for (const [id, org, email] of users) await ex(sql`insert into users (id, org_id, name, email, role) values (${id}::uuid, ${org}::uuid, 'u', ${email}, 'owner')`);
    const own: Array<[string, string, boolean]> = [[O(1), TENANT, true], [O(2), TENANT, false], [O(3), PAID, true], [O(4), PAID, true], [O(5), AGENCY, true], [O(6), AGENCY, true], [O(7), PENDING, true], [O(8), WEAK, true], [O(9), SUPER, true]];
    for (const [org, user, member] of own) {
      await ex(sql`update organizations set owner_id = ${user}::uuid, parent_user_id = ${user}::uuid where id = ${org}::uuid`);
      if (member) await ex(sql`insert into org_members (org_id, user_id, role) values (${org}::uuid, ${user}::uuid, 'owner')`);
    }
    // O(2) mirrors info@'s old home: owner_id set, parent_user_id NULL, NO owner membership.
    await ex(sql`update organizations set parent_user_id = null where id = ${O(2)}::uuid`);
    await ex(sql`insert into partner_agencies (id, name, slug, owner_user_id, owner_workspace_id, status) values
      (${AG_ACTIVE}::uuid, 'Agency A', 'scope-agency-a', ${AGENCY}::uuid, ${O(5)}::uuid, 'active'),
      (${AG_PENDING}::uuid, 'Agency P', 'scope-agency-p', ${PENDING}::uuid, ${O(7)}::uuid, 'pending'),
      (${AG_WEAK}::uuid, 'Agency W', 'scope-agency-w', ${WEAK}::uuid, ${O(8)}::uuid, 'active')`);
    await ex(sql`update organizations set parent_agency_id = ${AG_ACTIVE}::uuid where id = ${O(6)}::uuid`);
  });

  test("CONTROL before any grant: the tenant's second workspace inherits nothing (primary is free)", async () => {
    assert.equal(await tier(O(1)), "inactive");
    assert.equal(await tier(O(2)), "inactive");
  });

  test("internal grant: the granted workspace keeps Growth; the owner's other workspace does NOT inherit it", async () => {
    const ent = await T.setInternalWorkspaceEntitlement({ orgId: O(1), tier: "growth", actor: { userId: SUPER, email: SUPER_EMAIL } });
    assert.equal(ent.ok, true, JSON.stringify(ent));
    assert.equal(await tier(O(1)), "workspace", "EPIC-like workspace keeps its own internal Growth (= Workspace tier)");
    assert.equal(await R.workspaceHasPaidTier(O(1)), true, "feature gates on the granted workspace still pass");
    assert.equal(await tier(O(2)), "inactive", "the owner's other workspace must not inherit the internal grant");
  });

  test("users.planId mirroring the grant does not carry it; an independently paid user plan still does (Codex r1)", async () => {
    try {
      await ex(sql`update users set plan_id = 'growth' where id = ${TENANT}::uuid`);
      assert.equal(await tier(O(2)), "inactive", "a plan id mirrored from the internal grant must not be inherited");
      await ex(sql`update users set stripe_subscription_id = 'sub_tenant_own' where id = ${TENANT}::uuid`);
      assert.equal(await tier(O(2)), "inactive", "a stored subscription id alone (status trialing = plan picked, not paid) is not entitlement");
      for (const status of ["canceled", "unpaid"]) {
        await ex(sql`update users set subscription_status = ${status} where id = ${TENANT}::uuid`);
        assert.equal(await tier(O(2)), "inactive", `a ${status} user subscription is not entitlement`);
      }
      for (const status of ["active", "past_due"]) {
        await ex(sql`update users set subscription_status = ${status} where id = ${TENANT}::uuid`);
        assert.equal(await tier(O(2)), "workspace", `control: an independently paid (${status}) user plan keeps the users.planId fallback`);
      }
    } finally {
      // cleanup in finally so a failure here cannot pollute later tests (seen under the planid-mirror sabotage on 4f436733)
      await ex(sql`update users set plan_id = null, stripe_subscription_id = null, subscription_status = 'trialing' where id = ${TENANT}::uuid`);
    }
    assert.equal(await tier(O(2)), "inactive");
  });

  test("audit record unreadable: internal-shaped primary fails CLOSED; Stripe-paid primary unaffected (Codex r1)", async () => {
    await ex(sql`alter table workspace_admin_actions rename to workspace_admin_actions_offline`);
    try {
      assert.equal(await tier(O(2)), "inactive", "grant status unknown -> no inheritance");
      assert.equal(await tier(O(4)), "workspace", "control: a Stripe-paid primary needs no audit read and is still inherited");
      assert.equal(await tier(O(1)), "workspace", "the granted workspace itself keeps its own tier");
    } finally {
      await ex(sql`alter table workspace_admin_actions_offline rename to workspace_admin_actions`);
    }
    assert.equal(await tier(O(2)), "inactive");
  });

  test("users.planId fallback is UNCHANGED for owners whose primary is not internally granted (legacy/manual plans)", async () => {
    // PAID's primary is Stripe-paid -> inherits before reaching the fallback; make the primary free to reach it.
    await ex(sql`update organizations set subscription = '{}'::jsonb, plan = 'free' where id = ${O(3)}::uuid`);
    await ex(sql`update users set plan_id = 'workspace', subscription_status = 'trialing' where id = ${PAID}::uuid`);
    assert.equal(await tier(O(4)), "workspace", "pre-existing behaviour: users.planId fallback applies without any Stripe evidence");
    await ex(sql`update users set plan_id = null where id = ${PAID}::uuid`);
    await ex(sql`update organizations set plan = 'workspace', subscription = ${paidSub("workspace")} where id = ${O(3)}::uuid`);
  });

  test("PAID multi-workspace: a Stripe-paid primary is still inherited by the owner's other workspace", async () => {
    assert.equal(await tier(O(3)), "workspace");
    assert.equal(await tier(O(4)), "workspace");
  });

  test("AGENCY: a paid agency_scale owner's client workspace still inherits agency_scale", async () => {
    assert.equal(await tier(O(6)), "agency_scale");
  });

  test("PLATFORM ADMIN branch unchanged: a workspace owned by SF_SUPERADMIN resolves to agency_scale", async () => {
    assert.equal(await tier(O(9)), "agency_scale");
  });

  test("internal-grant scoping keys on the AUDIT RECORD, not on missing Stripe data", async () => {
    // A primary with the same shape as the internal grant ({tier, status} with no Stripe ids) but WITHOUT an audit record is
    // still inherited: absence of Stripe data alone never makes a subscription internal.
    await ex(sql`update organizations set subscription = '{"tier":"workspace","status":"active"}'::jsonb, plan = 'workspace' where id = ${O(8)}::uuid`);
    const extra = "b6000000-0000-4000-8000-000000000010";
    await ex(sql`insert into organizations (id, name, slug, plan, subscription, owner_id, parent_user_id) values (${extra}::uuid, 'scope-10', 'scope-ws-10', 'free', '{}'::jsonb, ${WEAK}::uuid, ${WEAK}::uuid)`);
    assert.equal(await tier(extra), "workspace");
    await ex(sql`update organizations set subscription = ${paidSub("workspace")} where id = ${O(8)}::uuid`);
  });

  test("reversal: after the real reversal script, the granted workspace is free and the other still inherits nothing", async () => {
    const [row] = ((r: any) => (Array.isArray(r) ? r : r.rows))(await ex(sql`select id from workspace_admin_actions where org_id = ${O(1)}::uuid and action = 'internal_entitlement' and outcome = 'applied' order by created_at desc limit 1`));
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('epic_revert.org', ${O(1)}, true), set_config('epic_revert.entitlement_action', ${row.id}, true), set_config('epic_revert.actor_id', ${SUPER}, true), set_config('epic_revert.actor_email', ${SUPER_EMAIL}, true)`);
      await tx.execute(sql.raw(block));
    });
    assert.equal(await tier(O(1)), "inactive");
    assert.equal(await tier(O(2)), "inactive");
  });

  test("authorised-agency gate: active + agency tier only; pending, non-agency-tier and tenants are not agencies", async () => {
    assert.equal(await A.hasAuthorizedAgency(AGENCY), true, "active agency on agency_scale");
    assert.equal(await A.hasAuthorizedAgency(PENDING), false, "pending agency");
    assert.equal(await A.hasAuthorizedAgency(WEAK), false, "active agency row but workspace on a non-agency (Workspace) plan");
    assert.equal(await A.hasAuthorizedAgency(TENANT), false, "tenant with two workspaces and no agency record");
    assert.equal(await A.hasAuthorizedAgency(PAID), false, "paid multi-workspace account without an agency record");
    assert.equal(await A.hasAuthorizedAgency(null), false);
  });

  test("workspace-creation count boundary: owner-role memberships, excluding the primary and archived workspaces", async () => {
    // TENANT owns O(1) (membership) and O(2) (owner_id only, NO membership) -> count excluding the primary = 0.
    assert.equal(await C.getOwnedWorkspaceCount(TENANT, O(1)), 0, "owner_id without an owner membership is not counted");
    assert.equal(await C.getOwnedWorkspaceCount(TENANT, null), 1, "control: the primary itself is counted when not excluded");
    await ex(sql`insert into org_members (org_id, user_id, role) values (${O(2)}::uuid, ${TENANT}::uuid, 'owner')`);
    assert.equal(await C.getOwnedWorkspaceCount(TENANT, O(1)), 1, "with an owner membership it counts");
    await ex(sql`update organizations set archived_at = now() where id = ${O(2)}::uuid`);
    assert.equal(await C.getOwnedWorkspaceCount(TENANT, O(1)), 0, "archived workspaces are excluded");
    await ex(sql`update organizations set archived_at = null where id = ${O(2)}::uuid`);
    await ex(sql`update org_members set role = 'admin' where org_id = ${O(2)}::uuid and user_id = ${TENANT}::uuid`);
    assert.equal(await C.getOwnedWorkspaceCount(TENANT, O(1)), 0, "non-owner roles are not counted");
    // PAID owns O(3)+O(4) with memberships: 1 besides the primary; Workspace cap is 1 -> a new build is refused.
    assert.equal(await C.getOwnedWorkspaceCount(PAID, O(3)), 1);
    const d = await L.enforceWorkspaceLimit({ userId: PAID, primaryOrgId: O(3), ownedWorkspaceCount: 1 });
    assert.deepEqual([d.allowed, d.tier], [false, "workspace"]);
    const ok = await L.enforceWorkspaceLimit({ userId: PAID, primaryOrgId: O(3), ownedWorkspaceCount: 0 });
    assert.equal(ok.allowed, true, "control: under the cap is allowed");
  });
});
