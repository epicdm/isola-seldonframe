// Recovery: the prepared reversal of an internal entitlement (scripts/ops/revert-internal-entitlement.sql) against a REAL Postgres
// through the production driver, after the REAL entitlement, transfer and rollback modules ran. Also proves the recommended operator
// home shape: a dedicated workspace linked to the platform admin exactly as the existing link-owner route leaves it
// (owner_id + parent_user_id + an owner membership) is accepted as the old owner's new home.
// Port ev-laneA-epic-company-setup-package-2026-10-20. Scratch database only; all fixtures are synthetic.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const SUPER = "a4000000-0000-4000-8000-000000000001", INFO = "a4000000-0000-4000-8000-000000000002";
const WS = "b4000000-0000-4000-8000-000000000001", INFO_HOME = "b4000000-0000-4000-8000-000000000002";
const OPS_HOME = "b4000000-0000-4000-8000-000000000003"; // dedicated operator home, linked as the link-owner route does
const SUPER_EMAIL = "ops@platform.test", INFO_EMAIL = "info@tenant.test";
const superActor = { userId: SUPER, email: SUPER_EMAIL };

describe("internal entitlement reversal (scratch Postgres, production driver)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let T: typeof import("@/lib/workspace/transfer-ownership");
  const revertSql = readFileSync(path.resolve("scripts/ops/revert-internal-entitlement.sql"), "utf8");

  const rows = async <R>(q: ReturnType<typeof sql>): Promise<R[]> => {
    const r = await db.execute(q);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as R[];
  };
  const org = async () => (await rows<{ plan: string | null; subscription: Record<string, unknown> | null; owner_id: string }>(
    sql`select plan, subscription, owner_id from organizations where id = ${WS}::uuid`))[0];
  const audits = async () => (await rows<{ n: string }>(sql`select count(*)::text as n from workspace_admin_actions where org_id = ${WS}::uuid`))[0].n;
  // The file's psql line binds the inputs with set_config(:'var'); here the same set_config runs with bound parameters, then the block.
  const block = revertSql.slice(revertSql.indexOf("DO $revert$"));
  const revert = async (ent: string, actorId = SUPER, actorEmail = SUPER_EMAIL) => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('epic_revert.org', ${WS}, true), set_config('epic_revert.entitlement_action', ${ent}, true), set_config('epic_revert.actor_id', ${actorId}, true), set_config('epic_revert.actor_email', ${actorEmail}, true)`);
        await tx.execute(sql.raw(block));
      });
      return "ok";
    } catch (error) {
      const m = /revert refused: ([a-z_]+)/.exec(String((error as { cause?: unknown }).cause ?? error) + String((error as Error).message));
      return m ? m[1] : `error: ${String(error)}`;
    }
  };

  before(async () => {
    process.env.SF_SUPERADMIN_EMAILS = SUPER_EMAIL;
    process.env.AUTH_SECRET = ["fixture", "operator", "secret", "only"].join("-");
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });
    ({ db } = await import("@/db"));
    T = await import("@/lib/workspace/transfer-ownership");

    const ex = (q: ReturnType<typeof sql>) => db.execute(q);
    await ex(sql`insert into organizations (id, name, slug, plan, subscription) values (${WS}::uuid, 'tenant', 'rev-tenant', 'free', '{}'::jsonb), (${INFO_HOME}::uuid, 'info-home', 'rev-info-home', 'free', '{}'::jsonb), (${OPS_HOME}::uuid, 'ops-home', 'rev-ops-home', 'free', '{}'::jsonb)`);
    await ex(sql`insert into users (id, org_id, name, email, role, plan_id) values (${SUPER}::uuid, ${WS}::uuid, 'ops', ${SUPER_EMAIL}, 'owner', 'free'), (${INFO}::uuid, ${INFO_HOME}::uuid, 'info', ${INFO_EMAIL}, 'owner', 'free')`);
    await ex(sql`update organizations set owner_id = ${SUPER}::uuid where id = ${WS}::uuid`);
    await ex(sql`update organizations set owner_id = ${INFO}::uuid where id = ${INFO_HOME}::uuid`);
    // The dedicated operator home exactly as link-owner leaves it: owner_id + parent_user_id + an owner membership.
    await ex(sql`update organizations set owner_id = ${SUPER}::uuid, parent_user_id = ${SUPER}::uuid where id = ${OPS_HOME}::uuid`);
    await ex(sql`insert into org_members (org_id, user_id, role) values (${OPS_HOME}::uuid, ${SUPER}::uuid, 'owner'), (${INFO_HOME}::uuid, ${INFO}::uuid, 'owner')`);
  });

  test("the full forward and back: entitlement, transfer to a dedicated operator home, refusals, rollback, reversal", async () => {
    const original = await org();
    assert.deepEqual([original.plan, original.subscription], ["free", {}]);

    const ent = await T.setInternalWorkspaceEntitlement({ orgId: WS, tier: "growth", actor: superActor });
    assert.equal(ent.ok, true, JSON.stringify(ent));
    if (!ent.ok) return;
    const entitled = await org();
    assert.equal(entitled.plan, "growth");

    const tr = await T.transferWorkspaceOwnership({ orgId: WS, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: OPS_HOME, actor: superActor });
    assert.equal(tr.ok, true, JSON.stringify(tr));
    if (!tr.ok) return;
    const home = (await rows<{ org_id: string }>(sql`select org_id from users where id = ${SUPER}::uuid`))[0].org_id;
    assert.equal(home, OPS_HOME, "the platform admin's home is now the dedicated operator workspace");

    // Refused while the transfer is applied; nothing changes, no audit row is added.
    const n0 = await audits();
    assert.equal(await revert(ent.actionId), "transfer_still_applied");
    assert.deepEqual(await org(), { ...entitled, owner_id: INFO });
    assert.equal(await audits(), n0);
    // Codex r5: audit created_at is transaction start time, so a transfer can carry an EARLIER stamp than the entitlement it followed.
    await db.execute(sql`update workspace_admin_actions set created_at = (select created_at from workspace_admin_actions where id = ${ent.actionId}::uuid) - interval '1 minute' where id = ${tr.actionId}::uuid`);
    assert.equal(await revert(ent.actionId), "transfer_still_applied", "an earlier-stamped applied transfer still blocks the reversal");
    assert.equal(await revert(ent.actionId, SUPER, "o'brien@platform.test"), "actor_not_found", "an apostrophe in an input is data, not SQL");

    const rb = await T.rollbackWorkspaceOwnershipTransfer({ orgId: WS, transferActionId: tr.actionId, actor: superActor });
    assert.equal(rb.ok, true, JSON.stringify(rb));
    const nAfterRollback = await audits();

    // Refusals that need no transfer: unknown action, wrong actor, drift.
    assert.equal(await revert("c4000000-0000-4000-8000-000000000099"), "entitlement_action_not_found");
    assert.equal(await revert(ent.actionId, INFO, SUPER_EMAIL), "actor_not_found");
    await db.execute(sql`update organizations set subscription = subscription || '{"status":"past_due"}'::jsonb where id = ${WS}::uuid`);
    assert.equal(await revert(ent.actionId), "state_drifted");
    await db.execute(sql`update organizations set subscription = subscription || '{"status":"active"}'::jsonb where id = ${WS}::uuid`);
    assert.equal(await audits(), nAfterRollback, "refusals wrote nothing");
    const nBefore = nAfterRollback;

    // Positive: restores the exact before-state and records itself.
    assert.equal(await revert(ent.actionId), "ok");
    const back = await org();
    assert.deepEqual([back.plan, back.subscription, back.owner_id], ["free", {}, SUPER]);
    assert.equal(Number(await audits()), Number(nBefore) + 1);
    const row = (await rows<{ action: string; outcome: string; reason: string; reverts_action_id: string; actor_email: string }>(
      sql`select action, outcome, reason, reverts_action_id, actor_email from workspace_admin_actions where org_id = ${WS}::uuid order by created_at desc limit 1`))[0];
    assert.deepEqual(row, { action: "internal_entitlement", outcome: "applied", reason: "revert", reverts_action_id: ent.actionId, actor_email: SUPER_EMAIL });

    // Idempotence: a second reversal is refused and changes nothing.
    assert.equal(await revert(ent.actionId), "already_reverted");
    assert.deepEqual(await org(), back);
  });
});
