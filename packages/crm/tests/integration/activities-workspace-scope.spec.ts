// EPIC 2026-10-21 — ROUTE-LEVEL test of POST /api/v1/activities (the exported route handler itself, production wiring: the real
// guardApiRequest resolving a real minted workspace bearer, real Drizzle queries against a scratch Postgres through the production
// driver). Defect def-uplink-v1-activities-cross-workspace-contact-attach-2026-10-21: the contact/deal existence checks were not
// scoped to the caller's workspace, so workspace A could attach an activity to workspace B's contact or deal.
// Every refusal has its positive twin in the same run (Law 19), and the fixture proves the foreign ids really exist (so a 404 means
// "refused", not "absent").
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND ACTIVITY_SCOPE_DB_TEST=scratch. The scratch database must carry the CRM schema.
// Run: node --import tsx --test tests/integration/activities-workspace-scope.spec.ts
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const ORG_A = "a7000000-0000-4000-8000-000000000001";
const ORG_B = "a7000000-0000-4000-8000-000000000002";
const USER_A = "b7000000-0000-4000-8000-000000000001";
const USER_B = "b7000000-0000-4000-8000-000000000002";
const CONTACT_A = "c7000000-0000-4000-8000-00000000000a";
const CONTACT_B = "c7000000-0000-4000-8000-00000000000b";
const PIPE_A = "d7000000-0000-4000-8000-00000000000a";
const PIPE_B = "d7000000-0000-4000-8000-00000000000b";
const DEAL_A = "e7000000-0000-4000-8000-00000000000a";
const DEAL_B = "e7000000-0000-4000-8000-00000000000b";
const MISSING = "f7000000-0000-4000-8000-0000000000ff";

describe("POST /api/v1/activities is scoped to the caller's workspace (scratch Postgres, production driver)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let POST: typeof import("@/app/api/v1/activities/route").POST;
  let bearerA = "";
  const count = async (where: ReturnType<typeof sql>) =>
    Number(((await db.execute(sql`select count(*)::int as n from activities where ${where}`)) as unknown as { rows: { n: number }[] }).rows[0].n);

  before(async () => {
    ({ db } = await import("@/db"));
    for (const t of ["activities", "deals", "pipelines", "contacts", "api_keys", "users"]) {
      await db.execute(sql.raw(`delete from ${t} where org_id in ('${ORG_A}','${ORG_B}')`));
    }
    await db.execute(sql`delete from organizations where id in (${ORG_A}::uuid, ${ORG_B}::uuid)`);
    await db.execute(sql`insert into organizations (id, name, slug) values (${ORG_A}::uuid, 'ws-a7', 'ws-a7'), (${ORG_B}::uuid, 'ws-b7', 'ws-b7')`);
    await db.execute(sql`insert into users (id, org_id, name, email) values (${USER_A}::uuid, ${ORG_A}::uuid, 'A owner', 'a7@scope.test'), (${USER_B}::uuid, ${ORG_B}::uuid, 'B owner', 'b7@scope.test')`);
    await db.execute(sql`insert into contacts (id, org_id, first_name) values (${CONTACT_A}::uuid, ${ORG_A}::uuid, 'Ann'), (${CONTACT_B}::uuid, ${ORG_B}::uuid, 'Bea')`);
    await db.execute(sql`insert into pipelines (id, org_id, name, stages, is_default) values (${PIPE_A}::uuid, ${ORG_A}::uuid, 'P', '[]'::jsonb, true), (${PIPE_B}::uuid, ${ORG_B}::uuid, 'P', '[]'::jsonb, true)`);
    await db.execute(sql`insert into deals (id, org_id, contact_id, pipeline_id, title, stage) values (${DEAL_A}::uuid, ${ORG_A}::uuid, ${CONTACT_A}::uuid, ${PIPE_A}::uuid, 'Deal A', 'New'), (${DEAL_B}::uuid, ${ORG_B}::uuid, ${CONTACT_B}::uuid, ${PIPE_B}::uuid, 'Deal B', 'New')`);
    const { mintWorkspaceToken } = await import("@/lib/auth/workspace-token");
    bearerA = (await mintWorkspaceToken(ORG_A, { name: "test:activities-scope" })).token;
    ({ POST } = await import("@/app/api/v1/activities/route"));
  });

  const post = async (payload: Record<string, unknown>): Promise<Response> => {
    const r = await POST(new Request("http://uplink.test/api/v1/activities", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerA}` },
      body: JSON.stringify({ type: "note", subject: "scope probe", ...payload }),
    }));
    assert.ok(r, "route returned no response");
    return r;
  };

  test("fixture control: the foreign contact and deal really exist, and every id is distinct", async () => {
    const r = (await db.execute(sql`select (select count(*) from contacts where id = ${CONTACT_B}::uuid and org_id = ${ORG_B}::uuid)::int as c, (select count(*) from deals where id = ${DEAL_B}::uuid and org_id = ${ORG_B}::uuid)::int as d`)) as unknown as { rows: { c: number; d: number }[] };
    assert.deepEqual(r.rows[0], { c: 1, d: 1 });
    assert.equal(new Set([CONTACT_A, CONTACT_B, DEAL_A, DEAL_B, MISSING]).size, 5);
  });

  test("positive control: workspace A attaches an activity to its OWN contact -> 201, row written in A", async () => {
    const before = await count(sql`org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`);
    const r = await post({ contact_id: CONTACT_A });
    assert.equal(r.status, 201);
    const j = (await r.json()) as { data: { orgId: string; contactId: string } };
    assert.equal(j.data.orgId, ORG_A);
    assert.equal(j.data.contactId, CONTACT_A);
    assert.equal(await count(sql`org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), before + 1);
  });

  test("positive control: workspace A attaches an activity to its OWN deal -> 201, row written in A", async () => {
    const before = await count(sql`org_id = ${ORG_A}::uuid and deal_id = ${DEAL_A}::uuid`);
    const r = await post({ deal_id: DEAL_A });
    assert.equal(r.status, 201);
    assert.equal(await count(sql`org_id = ${ORG_A}::uuid and deal_id = ${DEAL_A}::uuid`), before + 1);
  });

  test("workspace A naming workspace B's contact -> 404 'contact not found' (same as a missing id), NO row written anywhere", async () => {
    const r = await post({ contact_id: CONTACT_B });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "contact not found" });
    const missing = await post({ contactId: MISSING });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "contact not found" });
    assert.equal(await count(sql`contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("workspace A naming workspace B's deal -> 404 'deal not found', NO row written anywhere", async () => {
    const r = await post({ dealId: DEAL_B });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "deal not found" });
    assert.equal(await count(sql`deal_id = ${DEAL_B}::uuid`), 0);
  });

  test("own contact + foreign deal (mixed) -> 404, nothing written for either", async () => {
    const before = await count(sql`org_id = ${ORG_A}::uuid`);
    const r = await post({ contact_id: CONTACT_A, deal_id: DEAL_B });
    assert.equal(r.status, 404);
    assert.equal(await count(sql`org_id = ${ORG_A}::uuid`), before);
    assert.equal(await count(sql`deal_id = ${DEAL_B}::uuid`), 0);
  });

  test("camelCase keys: own contactId -> 201 (positive control); foreign contactId -> 404, nothing written", async () => {
    const own = await post({ contactId: CONTACT_A });
    assert.equal(own.status, 201);
    assert.equal(((await own.json()) as { data: { contactId: string } }).data.contactId, CONTACT_A);
    const foreign = await post({ contactId: CONTACT_B });
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { error: "contact not found" });
    assert.equal(await count(sql`contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("a missing deal id gets the same 404 body as a foreign one (no existence oracle)", async () => {
    const missing = await post({ deal_id: MISSING });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "deal not found" });
  });

  test("foreign contact + own deal (mixed, other way round) -> 404, nothing written in A", async () => {
    const before = await count(sql`org_id = ${ORG_A}::uuid`);
    const r = await post({ contactId: CONTACT_B, dealId: DEAL_A });
    assert.equal(r.status, 404);
    assert.equal(await count(sql`org_id = ${ORG_A}::uuid`), before);
  });

  test("positive control: own contact + own deal together -> 201", async () => {
    const r = await post({ contact_id: CONTACT_A, deal_id: DEAL_A });
    assert.equal(r.status, 201);
  });

  test("no cross-workspace activity row exists after the run (activity org differs from its contact's or deal's org)", async () => {
    const r = (await db.execute(sql`select count(*)::int as n from activities a left join contacts c on c.id = a.contact_id left join deals d on d.id = a.deal_id where a.org_id in (${ORG_A}::uuid, ${ORG_B}::uuid) and ((c.id is not null and c.org_id <> a.org_id) or (d.id is not null and d.org_id <> a.org_id))`)) as unknown as { rows: { n: number }[] };
    assert.equal(r.rows[0].n, 0);
  });
});
