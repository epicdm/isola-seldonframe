// EPIC 2026-10-21 — Law 21 siblings found by Codex review of the activity-scope fix: three operator-portal server actions took a
// contactId from the client and used it under the session's workspace without checking the contact belongs to it:
//   sendReplyAction (SMS reply), addNoteAction (conversation note), requestReviewAction (review request email/SMS).
// The real actions run against a scratch Postgres through the production driver. The only seam is the operator session
// (requireOperatorSessionForOrg -> workspace A); outbound HTTP is recorded and refused so no real provider is reached.
// Every refusal has an own-contact positive twin in the same run, and the fixture proves the foreign contact exists.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set, DB_DRIVER=pg AND ACTIVITY_SCOPE_DB_TEST=scratch. Needs
// node --experimental-test-module-mocks.
// Run: node --experimental-test-module-mocks --import tsx --test tests/integration/operator-portal-contact-scope.spec.ts
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST && process.env.DB_DRIVER === "pg";

const ORG_A = "aa000000-0000-4000-8000-000000000001";
const ORG_B = "aa000000-0000-4000-8000-000000000002";
const USER_A = "ba000000-0000-4000-8000-000000000001";
const CONTACT_A = "ca000000-0000-4000-8000-00000000000a";
const CONTACT_B = "ca000000-0000-4000-8000-00000000000b";

describe("operator-portal actions scope the client's contactId to the session workspace (scratch Postgres)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch and DB_DRIVER=pg with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let M: typeof import("@/lib/operator-portal/messages-actions");
  let T: typeof import("@/lib/operator-portal/today-actions");
  const outbound: string[] = [];
  const n = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n);

  before(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      throw new Error("network disabled in this spec");
    }) as typeof fetch;
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/lib/operator-portal/auth.ts")).href, {
      namedExports: { requireOperatorSessionForOrg: async () => ({ orgId: ORG_A, email: "op@scope.test" }) },
    });
    ({ db } = await import("@/db"));
    for (const t of ["conversation_notes", "sms_messages", "emails", "activities", "contacts", "users"]) {
      await db.execute(sql.raw(`delete from ${t} where org_id in ('${ORG_A}','${ORG_B}')`));
    }
    await db.execute(sql`delete from organizations where id in (${ORG_A}::uuid, ${ORG_B}::uuid)`);
    // outboundSmsEnabled = true so sendReplyAction reaches the contact check (with it false, both cases would stop at the flag)
    await db.execute(sql`insert into organizations (id, name, slug, integrations) values (${ORG_A}::uuid, 'ws-aa', 'ws-aa', '{"twilio":{"outboundSmsEnabled":true}}'::jsonb), (${ORG_B}::uuid, 'ws-ba', 'ws-ba', '{}'::jsonb)`);
    await db.execute(sql`insert into users (id, org_id, name, email) values (${USER_A}::uuid, ${ORG_A}::uuid, 'A op', 'aa@scope.test')`);
    await db.execute(sql`update organizations set owner_id = ${USER_A}::uuid where id = ${ORG_A}::uuid`);
    await db.execute(sql`insert into contacts (id, org_id, first_name, email, phone) values (${CONTACT_A}::uuid, ${ORG_A}::uuid, 'Ann', 'ann-aa@scope.test', '+15550100011'), (${CONTACT_B}::uuid, ${ORG_B}::uuid, 'Bea', 'bea-aa@scope.test', '+15550100012')`);
    M = await import("@/lib/operator-portal/messages-actions");
    T = await import("@/lib/operator-portal/today-actions");
  });

  test("fixture control: the foreign contact exists in workspace B; the A flag is on", async () => {
    assert.equal(await n(sql`select count(*)::int as n from contacts where id = ${CONTACT_B}::uuid and org_id = ${ORG_B}::uuid`), 1);
    const { getOutboundSmsEnabled } = await import("@/lib/operator-portal/outbound-sms-flag");
    assert.equal(await getOutboundSmsEnabled(ORG_A), true);
  });

  test("addNoteAction: own contact -> note in A (positive control); foreign contact -> refused, no note", async () => {
    const own = await M.addNoteAction({ orgSlug: "ws-aa", contactId: CONTACT_A, body: "own" });
    assert.equal(own.ok, true, JSON.stringify(own));
    assert.equal(await n(sql`select count(*)::int as n from conversation_notes where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), 1);
    const foreign = await M.addNoteAction({ orgSlug: "ws-aa", contactId: CONTACT_B, body: "foreign" });
    assert.deepEqual(foreign, { ok: false, error: "Contact not found" });
    assert.equal(await n(sql`select count(*)::int as n from conversation_notes where contact_id = ${CONTACT_B}::uuid`), 0);
  });

  test("sendReplyAction: foreign contact -> contact_not_found, no sms row, no provider call; own contact passes to the send stage", async () => {
    const sentBefore = outbound.length;
    const foreign = await M.sendReplyAction({ orgSlug: "ws-aa", contactId: CONTACT_B, toNumber: "+15550100012", body: "x" });
    assert.deepEqual(foreign, { ok: false, error: "contact_not_found" });
    assert.equal(outbound.length, sentBefore);
    assert.equal(await n(sql`select count(*)::int as n from sms_messages where contact_id = ${CONTACT_B}::uuid`), 0);
    // No Twilio number in the scratch workspace: the own-contact reply gets PAST the scope gate and stops at the send stage.
    const own = await M.sendReplyAction({ orgSlug: "ws-aa", contactId: CONTACT_A, toNumber: "+15550100011", body: "x" });
    assert.deepEqual(own, { ok: false, error: "Twilio fromNumber not configured for this workspace" });
  });

  test("requestReviewAction: foreign contact -> refused, no email/sms row, no provider call; own contact proceeds (positive control)", async () => {
    const sentBefore = outbound.length;
    const foreign = await T.requestReviewAction({ orgSlug: "ws-aa", contactId: CONTACT_B, toEmail: "bea-aa@scope.test", toPhone: "", contactName: "Bea", reviewLink: "https://review.test/x" });
    assert.deepEqual(foreign, { ok: false, error: "Contact not found" });
    assert.equal(outbound.length, sentBefore);
    assert.equal(await n(sql`select ((select count(*) from emails where contact_id = ${CONTACT_B}::uuid) + (select count(*) from sms_messages where contact_id = ${CONTACT_B}::uuid))::int as n`), 0);
    const own = await T.requestReviewAction({ orgSlug: "ws-aa", contactId: CONTACT_A, toEmail: "ann-aa@scope.test", toPhone: "", contactName: "Ann", reviewLink: "https://review.test/x" });
    assert.notDeepEqual(own, { ok: false, error: "Contact not found" });
    assert.equal(await n(sql`select count(*)::int as n from emails where org_id = ${ORG_A}::uuid and contact_id = ${CONTACT_A}::uuid`), 1, JSON.stringify(own));
  });
});
