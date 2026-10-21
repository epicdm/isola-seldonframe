// EPIC 2026-10-21 — Law 21 sibling of def-uplink-v1-activities-cross-workspace-contact-attach-2026-10-21: the operator server action
// createActivityAction (lib/activities/actions.ts, used by the activity form and the contact record "Log activity" form) wrote the
// contact, deal and user ids from the form without checking them against the session's workspace.
// The real action runs against a scratch Postgres through the production driver. The only seams are the session (getOrgId /
// getCurrentUser, i.e. "who is signed in, in which workspace") and next/cache revalidatePath (no Next runtime in node:test).
// Every refusal has an own-id positive twin in the same run.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND ACTIVITY_SCOPE_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
// Run: node --experimental-test-module-mocks --import tsx --test tests/integration/activity-action-workspace-scope.spec.ts
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const ORG_A = "a9000000-0000-4000-8000-000000000001";
const ORG_B = "a9000000-0000-4000-8000-000000000002";
const USER_A = "b9000000-0000-4000-8000-000000000001"; // signed-in operator, home org A
const USER_A2 = "b9000000-0000-4000-8000-000000000003"; // teammate, home org A
const USER_M = "b9000000-0000-4000-8000-000000000004"; // home org B, member of A via org_members
const USER_B = "b9000000-0000-4000-8000-000000000002"; // home org B, no link to A
const CONTACT_A = "c9000000-0000-4000-8000-00000000000a";
const CONTACT_B = "c9000000-0000-4000-8000-00000000000b";
const PIPE_A = "d9000000-0000-4000-8000-00000000000a";
const PIPE_B = "d9000000-0000-4000-8000-00000000000b";
const DEAL_A = "e9000000-0000-4000-8000-00000000000a";
const DEAL_B = "e9000000-0000-4000-8000-00000000000b";

describe("createActivityAction scopes contact, deal and user ids to the session workspace (scratch Postgres)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let createActivityAction: typeof import("@/lib/activities/actions").createActivityAction;
  const n = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n);
  const form = (f: Record<string, string>) => {
    const fd = new FormData();
    fd.set("type", "note");
    fd.set("subject", "scope probe");
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    return fd;
  };

  before(async () => {
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/lib/auth/helpers.ts")).href, {
      namedExports: { getOrgId: async () => ORG_A, getCurrentUser: async () => ({ id: USER_A, orgId: ORG_A }) },
    });
    mock.module("next/cache", { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } });
    ({ db } = await import("@/db"));
    await db.execute(sql.raw(`delete from org_members where org_id in ('${ORG_A}','${ORG_B}')`));
    for (const t of ["activities", "deals", "pipelines", "contacts", "users"]) {
      await db.execute(sql.raw(`delete from ${t} where org_id in ('${ORG_A}','${ORG_B}')`));
    }
    await db.execute(sql`delete from organizations where id in (${ORG_A}::uuid, ${ORG_B}::uuid)`);
    await db.execute(sql`insert into organizations (id, name, slug) values (${ORG_A}::uuid, 'ws-a9', 'ws-a9'), (${ORG_B}::uuid, 'ws-b9', 'ws-b9')`);
    await db.execute(sql`insert into users (id, org_id, name, email) values
      (${USER_A}::uuid, ${ORG_A}::uuid, 'A op', 'a9@scope.test'), (${USER_A2}::uuid, ${ORG_A}::uuid, 'A mate', 'a9b@scope.test'),
      (${USER_M}::uuid, ${ORG_B}::uuid, 'Member', 'm9@scope.test'), (${USER_B}::uuid, ${ORG_B}::uuid, 'B op', 'b9@scope.test')`);
    await db.execute(sql`insert into org_members (org_id, user_id) values (${ORG_A}::uuid, ${USER_M}::uuid)`);
    await db.execute(sql`insert into contacts (id, org_id, first_name) values (${CONTACT_A}::uuid, ${ORG_A}::uuid, 'Ann'), (${CONTACT_B}::uuid, ${ORG_B}::uuid, 'Bea')`);
    await db.execute(sql`insert into pipelines (id, org_id, name, stages, is_default) values (${PIPE_A}::uuid, ${ORG_A}::uuid, 'P', '[]'::jsonb, true), (${PIPE_B}::uuid, ${ORG_B}::uuid, 'P', '[]'::jsonb, true)`);
    await db.execute(sql`insert into deals (id, org_id, contact_id, pipeline_id, title, stage) values (${DEAL_A}::uuid, ${ORG_A}::uuid, ${CONTACT_A}::uuid, ${PIPE_A}::uuid, 'Deal A', 'New'), (${DEAL_B}::uuid, ${ORG_B}::uuid, ${CONTACT_B}::uuid, ${PIPE_B}::uuid, 'Deal B', 'New')`);
    ({ createActivityAction } = await import("@/lib/activities/actions"));
  });

  test("fixture control: foreign contact, deal and user really exist in workspace B", async () => {
    assert.equal(await n(sql`select ((select count(*) from contacts where id = ${CONTACT_B}::uuid and org_id = ${ORG_B}::uuid) + (select count(*) from deals where id = ${DEAL_B}::uuid and org_id = ${ORG_B}::uuid) + (select count(*) from users where id = ${USER_B}::uuid and org_id = ${ORG_B}::uuid))::int as n`), 3);
  });

  test("positive control: signed-in user, own contact and own deal -> activity written in A", async () => {
    await createActivityAction(form({ userId: USER_A, contactId: CONTACT_A, dealId: DEAL_A }));
    assert.equal(await n(sql`select count(*)::int as n from activities where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid and deal_id = ${DEAL_A}::uuid and user_id = ${USER_A}::uuid`), 1);
  });

  test("positive control: a teammate (home org A) and an org member (home org B, member of A) may be the activity user", async () => {
    await createActivityAction(form({ userId: USER_A2, contactId: CONTACT_A }));
    await createActivityAction(form({ userId: USER_M, contactId: CONTACT_A }));
    assert.equal(await n(sql`select count(*)::int as n from activities where org_id = ${ORG_A}::uuid and user_id in (${USER_A2}::uuid, ${USER_M}::uuid)`), 2);
  });

  test("foreign contact -> 'Contact not found', nothing written", async () => {
    await assert.rejects(createActivityAction(form({ userId: USER_A, contactId: CONTACT_B })), /Contact not found/);
    assert.equal(await n(sql`select count(*)::int as n from activities where contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("foreign deal -> 'Deal not found', nothing written", async () => {
    await assert.rejects(createActivityAction(form({ userId: USER_A, contactId: CONTACT_A, dealId: DEAL_B })), /Deal not found/);
    assert.equal(await n(sql`select count(*)::int as n from activities where deal_id = ${DEAL_B}::uuid`), 0);
  });

  test("user from another workspace (no membership in A) -> 'User not found', nothing written", async () => {
    await assert.rejects(createActivityAction(form({ userId: USER_B, contactId: CONTACT_A })), /User not found/);
    assert.equal(await n(sql`select count(*)::int as n from activities where user_id = ${USER_B}::uuid`), 0);
  });
});
