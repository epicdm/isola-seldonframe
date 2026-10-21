// EPIC 2026-10-21 — Law 21 siblings of def-uplink-v1-activities-cross-workspace-contact-attach-2026-10-21. Each path accepted a
// contact id from the caller without checking it belongs to the caller's workspace:
//   POST /api/v1/deals, POST /api/v1/emails, POST /api/v1/sms (route handlers, real guard + real minted workspace bearer), and the
//   agent tool create_activity (the real makeAgentToolInvoker, the same entry the agent runtime uses).
// Real Drizzle queries against a scratch Postgres through the production driver. Each refusal has an own-id positive twin in the same
// run, and the fixture proves the foreign contact exists (so a refusal means "refused", not "absent").
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set, DB_DRIVER=pg (direct Postgres, so no test fetch stub can touch the DB
// transport) AND ACTIVITY_SCOPE_DB_TEST=scratch. The scratch database must carry the CRM schema.
// Run: node --import tsx --test tests/integration/workspace-id-scope-siblings.spec.ts
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST && process.env.DB_DRIVER === "pg";

const ORG_A = "a8000000-0000-4000-8000-000000000001";
const ORG_B = "a8000000-0000-4000-8000-000000000002";
const USER_A = "b8000000-0000-4000-8000-000000000001";
const USER_B = "b8000000-0000-4000-8000-000000000002";
const CONTACT_A = "c8000000-0000-4000-8000-00000000000a";
const CONTACT_B = "c8000000-0000-4000-8000-00000000000b";
const PIPE_A = "d8000000-0000-4000-8000-00000000000a";

describe("caller-supplied contact ids are scoped to the caller's workspace (scratch Postgres, production driver)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch and DB_DRIVER=pg with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let bearerA = "";
  let routes: {
    deals: typeof import("@/app/api/v1/deals/route").POST;
    emails: typeof import("@/app/api/v1/emails/route").POST;
    sms: typeof import("@/app/api/v1/sms/route").POST;
  };
  let invoke: ReturnType<typeof import("@/lib/agents/tool-invoker").makeAgentToolInvoker>;
  const n = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n);

  const outbound: string[] = [];
  before(async () => {
    // No real mail/SMS provider may be reached from this spec: every outbound HTTP call is recorded and refused.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      throw new Error("network disabled in this spec");
    }) as typeof fetch;
    ({ db } = await import("@/db"));
    for (const t of ["activities", "emails", "sms_messages", "deals", "pipelines", "contacts", "api_keys", "users"]) {
      await db.execute(sql.raw(`delete from ${t} where org_id in ('${ORG_A}','${ORG_B}')`));
    }
    await db.execute(sql`delete from organizations where id in (${ORG_A}::uuid, ${ORG_B}::uuid)`);
    await db.execute(sql`insert into organizations (id, name, slug) values (${ORG_A}::uuid, 'ws-a8', 'ws-a8'), (${ORG_B}::uuid, 'ws-b8', 'ws-b8')`);
    await db.execute(sql`insert into users (id, org_id, name, email) values (${USER_A}::uuid, ${ORG_A}::uuid, 'A owner', 'a8@scope.test'), (${USER_B}::uuid, ${ORG_B}::uuid, 'B owner', 'b8@scope.test')`);
    await db.execute(sql`update organizations set owner_id = ${USER_A}::uuid where id = ${ORG_A}::uuid`);
    await db.execute(sql`update organizations set owner_id = ${USER_B}::uuid where id = ${ORG_B}::uuid`);
    await db.execute(sql`insert into contacts (id, org_id, first_name, email, phone) values (${CONTACT_A}::uuid, ${ORG_A}::uuid, 'Ann', 'ann@scope.test', '+15550100001'), (${CONTACT_B}::uuid, ${ORG_B}::uuid, 'Bea', 'bea@scope.test', '+15550100002')`);
    await db.execute(sql`insert into pipelines (id, org_id, name, stages, is_default) values (${PIPE_A}::uuid, ${ORG_A}::uuid, 'P', '[]'::jsonb, true)`);
    const { mintWorkspaceToken } = await import("@/lib/auth/workspace-token");
    bearerA = (await mintWorkspaceToken(ORG_A, { name: "test:id-scope-siblings" })).token;
    routes = {
      deals: (await import("@/app/api/v1/deals/route")).POST,
      emails: (await import("@/app/api/v1/emails/route")).POST,
      sms: (await import("@/app/api/v1/sms/route")).POST,
    };
    invoke = (await import("@/lib/agents/tool-invoker")).makeAgentToolInvoker(ORG_A);
  });

  const call = async (handler: (r: Request) => Promise<Response | undefined>, path: string, payload: Record<string, unknown>) => {
    const r = await handler(new Request(`http://uplink.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerA}` },
      body: JSON.stringify(payload),
    }));
    assert.ok(r, "route returned no response");
    return r;
  };
  // A path that refuses with 404 may also throw on a later, unrelated step for the own-id control (no mail/SMS provider in the
  // scratch environment); capture either outcome so the control can prove the scope gate was PASSED.
  const outcome = async (fn: () => Promise<Response>) => {
    try {
      const r = await fn();
      return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null, thrown: null as string | null };
    } catch (e) {
      return { status: null as number | null, body: null, thrown: e instanceof Error ? e.message : String(e) };
    }
  };

  test("fixture control: the foreign contact exists in workspace B and ids are distinct", async () => {
    assert.equal(await n(sql`select count(*)::int as n from contacts where id = ${CONTACT_B}::uuid and org_id = ${ORG_B}::uuid`), 1);
    assert.notEqual(CONTACT_A, CONTACT_B);
  });

  test("deals POST: own contact -> 201 deal in A (positive control); foreign contact -> 404, no deal written", async () => {
    const own = await call(routes.deals, "/api/v1/deals", { contactId: CONTACT_A, title: "own" });
    assert.equal(own.status, 201);
    assert.equal(await n(sql`select count(*)::int as n from deals where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), 1);
    const foreign = await call(routes.deals, "/api/v1/deals", { contactId: CONTACT_B, title: "foreign" });
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { error: "contact not found" });
    assert.equal(await n(sql`select count(*)::int as n from deals where contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("emails POST: foreign contactId -> 404 before anything is queued; own contactId passes the scope gate (positive control)", async () => {
    const sentBefore = outbound.length;
    const foreign = await outcome(() => call(routes.emails, "/api/v1/emails", { to: "x@scope.test", subject: "s", body: "b", contactId: CONTACT_B }));
    assert.equal(outbound.length, sentBefore, "a refused email must not reach any provider");
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: "contact not found" });
    assert.equal(await n(sql`select count(*)::int as n from emails where contact_id = ${CONTACT_B}::uuid`), 0);
    const own = await outcome(() => call(routes.emails, "/api/v1/emails", { to: "ann@scope.test", subject: "s", body: "b", contactId: CONTACT_A }));
    assert.equal(own.status, 201, JSON.stringify(own));
    assert.equal((own.body as { data: { contactId: string } }).data.contactId, CONTACT_A);
    assert.equal(await n(sql`select count(*)::int as n from emails where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), 1);
  });

  test("sms POST: foreign contactId -> 404 before anything is queued; own contactId passes the scope gate (positive control)", async () => {
    const sentBefore = outbound.length;
    const foreign = await outcome(() => call(routes.sms, "/api/v1/sms", { to: "+15550100002", body: "b", contactId: CONTACT_B }));
    assert.equal(outbound.length, sentBefore, "a refused sms must not reach any provider");
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: "contact not found" });
    assert.equal(await n(sql`select count(*)::int as n from sms_messages where contact_id = ${CONTACT_B}::uuid`), 0);
    const own = await outcome(() => call(routes.sms, "/api/v1/sms", { to: "+15550100001", body: "b", contactId: CONTACT_A }));
    // No Twilio number in the scratch workspace: the own-contact request gets PAST the scope gate and stops at the send stage.
    assert.deepEqual([own.status, own.body], [422, { error: "Twilio fromNumber not configured for this workspace" }], JSON.stringify(own));
  });

  test("agent tool create_activity: own contact -> row in A (positive control); model-supplied foreign contact -> refused, no row", async () => {
    const own = (await invoke("create_activity", { contact_id: CONTACT_A, type: "agent_action", subject: "own" })) as { data: { id: string; contactId: string } };
    assert.equal(own.data.contactId, CONTACT_A);
    assert.equal(await n(sql`select count(*)::int as n from activities where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), 1);
    await assert.rejects(
      invoke("create_activity", { contact_id: CONTACT_B, type: "agent_action", subject: "foreign" }),
      /contact not found in this workspace/,
    );
    assert.equal(await n(sql`select count(*)::int as n from activities where contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("agent tool create_activity: a foreign contact from the run context is refused too", async () => {
    await assert.rejects(
      invoke("create_activity", { type: "agent_action", subject: "ctx" }, { runContext: { customer: { contactId: CONTACT_B } } as never }),
      /contact not found in this workspace/,
    );
    assert.equal(await n(sql`select count(*)::int as n from activities where contact_id = ${CONTACT_B}::uuid`), 0);
  });
});
