// Super-admin Workspaces list and user detail render the last-activity time instead of throwing
// (def-uplink-super-admin-workspaces-last-activity-toisostring-crash-2026-10-20). Runs the real lib/super-admin queries against a
// REAL Postgres through the production driver (DB_DRIVER=pg): the defect only exists with the real driver, which returns a raw
// MAX(...) aggregate as a string. Only next/cache is faked. Scratch database only; all fixtures are synthetic.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const OWNER = "a2000000-0000-4000-8000-000000000001";
const ACTIVE = "b2000000-0000-4000-8000-000000000001";
const QUIET = "b2000000-0000-4000-8000-000000000002";
const LAST = "2026-10-20T05:42:46.000Z";

describe("super-admin last activity (scratch Postgres, production driver)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let W: typeof import("@/lib/super-admin/workspaces");
  let UD: typeof import("@/lib/super-admin/users");

  before(async () => {
    mock.module("next/cache", { namedExports: { unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined, revalidatePath: () => undefined } });
    ({ db } = await import("@/db"));
    W = await import("@/lib/super-admin/workspaces");
    UD = await import("@/lib/super-admin/users");
    await db.execute(sql`insert into organizations (id, name, slug, owner_id) values (${ACTIVE}::uuid, 'active', 'sa-active', null), (${QUIET}::uuid, 'quiet', 'sa-quiet', null)`);
    await db.execute(sql`insert into users (id, org_id, name, email, role, plan_id) values (${OWNER}::uuid, ${ACTIVE}::uuid, 'owner', 'owner@sa.test', 'owner', 'free')`);
    await db.execute(sql`update organizations set owner_id = ${OWNER}::uuid where id in (${ACTIVE}::uuid, ${QUIET}::uuid)`);
    await db.execute(sql`insert into activities (org_id, user_id, type, created_at) values (${ACTIVE}::uuid, ${OWNER}::uuid, 'note', ${LAST}::timestamptz - interval '1 hour'), (${ACTIVE}::uuid, ${OWNER}::uuid, 'note', ${LAST}::timestamptz)`);
  });

  test("control: with the production driver a raw MAX(created_at) aggregate arrives as a string (the defect's precondition)", async () => {
    const { activities } = await import("@/db/schema");
    const [row] = await db.select({ lastAt: sql<unknown>`MAX(${activities.createdAt})` }).from(activities).where(sql`${activities.orgId} = ${ACTIVE}::uuid`);
    assert.equal(typeof row.lastAt, "string");
  });

  test("the Workspaces list renders: last activity is the newest activity as ISO, null when there is none", async () => {
    const result = await W.listWorkspaces({ limit: 200, sort: "activity" });
    const active = result.rows.find((r) => r.id === ACTIVE);
    const quiet = result.rows.find((r) => r.id === QUIET);
    assert.ok(active && quiet, "both fixture workspaces are listed");
    assert.equal(active.lastActivityAt, LAST);
    assert.equal(quiet.lastActivityAt, null);
    assert.equal(result.rows.indexOf(active) < result.rows.indexOf(quiet), true, "activity sort puts the active workspace first");
  });

  test("the user detail renders the same last activity for the user's owned workspaces", async () => {
    const detail = await UD.getUserDetail(OWNER);
    assert.ok(detail, "user detail resolves");
    const byId = new Map(detail.workspaces.map((w) => [w.id, w.lastActivityAt]));
    assert.equal(byId.get(ACTIVE), LAST);
    assert.equal(byId.get(QUIET), null);
  });
});
