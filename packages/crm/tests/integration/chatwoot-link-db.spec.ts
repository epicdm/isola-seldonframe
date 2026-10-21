// Chatwoot customer link: the REAL SQL store against a real Postgres (scratch), proving the workspace scoping is in the query, not just in
// the in-memory fake the unit spec uses. Run explicitly:
//   CHATWOOT_LINK_TEST_DATABASE_URL=postgres://... node --import tsx --test tests/integration/chatwoot-link-db.spec.ts
// It FAILS (does not skip) when the URL is missing: a test that passes because nothing ran is not a test. Fictional rows; the scratch DB
// gets the app schema from `drizzle-kit export`. Every absence assertion has a positive control here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema";
import { activities, contacts, organizations, users } from "@/db/schema";
import { CHATWOOT_LINK_ACTIVITY_TYPE, chatwootLinkKey } from "@/lib/chatwoot-link/record";
import { confirmChatwootLink, findChatwootCandidates, getChatwootLinkState, type ChatwootLinkDeps } from "@/lib/chatwoot-link/service";
import type { ChatwootReader } from "@/lib/chatwoot-link/reader";
import { makeChatwootLinkStore } from "@/lib/chatwoot-link/wiring";

const url = process.env.CHATWOOT_LINK_TEST_DATABASE_URL;
const pool = new Pool({ connectionString: url ?? "postgres://invalid.invalid/none", max: 2 });
const database = drizzle(pool, { schema, casing: "snake_case" }) as unknown as NonNullable<Parameters<typeof makeChatwootLinkStore>[0]>;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const CONTACT_A = randomUUID();
const CONTACT_B = randomUUID();
let calls = 0;

const reader: ChatwootReader = {
  async searchContacts(q) {
    calls++;
    return { contacts: q === "5550100123" ? [{ id: 501, name: "Test Customer", phone: "+15550100123", email: null }] : [], complete: true };
  },
  async contactConversations(id) {
    calls++;
    return id === 501
      ? [
          { displayId: 41, inboxId: 11, status: "open", lastActivityAt: 1_760_000_000 },
          { displayId: 17, inboxId: 7, status: "resolved", lastActivityAt: 1_750_000_000 },
        ]
      : [];
  },
};

const key = chatwootLinkKey({ AUTH_SECRET: "test-auth-secret-fictional-0123456789" });
const deps = (): ChatwootLinkDeps => ({
  store: makeChatwootLinkStore(database),
  target: { publicBase: "https://chat.example.test", accountId: "2" },
  lookup: { publicBase: "https://chat.example.test", accountId: "2", apiBase: "http://cw.invalid", apiToken: "unused" },
  reader,
  key,
  now: () => new Date("2026-10-21T12:00:00.000Z"),
});

before(async () => {
  assert.ok(url, "CHATWOOT_LINK_TEST_DATABASE_URL must be set: this spec needs a real (scratch) Postgres");
  await database.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: `org-a-${ORG_A.slice(0, 8)}` },
    { id: ORG_B, name: "Org B", slug: `org-b-${ORG_B.slice(0, 8)}` },
  ] as never);
  await database.insert(users).values([
    { id: USER_A, orgId: ORG_A, name: "Admin A", email: `a-${USER_A}@example.test`, role: "owner" },
    { id: USER_B, orgId: ORG_B, name: "Admin B", email: `b-${USER_B}@example.test`, role: "owner" },
  ] as never);
  await database.insert(contacts).values([
    { id: CONTACT_A, orgId: ORG_A, firstName: "Test", phone: "(555) 010-0123" },
    { id: CONTACT_B, orgId: ORG_B, firstName: "Same", phone: "+1 555 010 0123" },
  ] as never);
});
after(() => pool.end());

describe("real SQL store: workspace scoping is in the query", () => {
  test("getContact: own workspace finds it; the other workspace's id is not found (both directions)", async () => {
    const store = makeChatwootLinkStore(database);
    assert.equal((await store.getContact(ORG_A, CONTACT_A))?.id, CONTACT_A); // control
    assert.equal(await store.getContact(ORG_A, CONTACT_B), null);
    assert.equal(await store.getContact(ORG_B, CONTACT_A), null);
  });

  test("cross-workspace lookup/confirm: not found, no Chatwoot call, no row written", async () => {
    calls = 0;
    const d = deps();
    const asA = { orgId: ORG_A, userId: USER_A, role: "admin", realPerson: true };
    assert.deepEqual(await findChatwootCandidates(asA, CONTACT_B, d), { ok: false, code: "not_found" });
    assert.deepEqual(await confirmChatwootLink(asA, { contactId: CONTACT_B, chatwootContactId: 501, conversationId: 41 }, d), { ok: false, code: "not_found" });
    assert.equal(calls, 0);
    const [{ n }] = (await pool.query("select count(*)::int as n from activities where contact_id = $1", [CONTACT_B])).rows;
    assert.equal(n, 0);
  });

  test("confirm in own workspace writes ONE activity row with the session's org/user and shows the link; other workspace sees nothing", async () => {
    calls = 0;
    const d = deps();
    const asA = { orgId: ORG_A, userId: USER_A, role: "owner", realPerson: true };
    const r = await confirmChatwootLink(asA, { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 }, d);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(calls > 0, "control: Chatwoot was read for the legitimate confirm");
    const rows = (await pool.query("select org_id, user_id, type, subject from activities where contact_id = $1", [CONTACT_A])).rows;
    assert.deepEqual(rows, [{ org_id: ORG_A, user_id: USER_A, type: CHATWOOT_LINK_ACTIVITY_TYPE, subject: "Linked to Chatwoot conversation #41" }]);
    assert.deepEqual(await getChatwootLinkState(ORG_A, CONTACT_A, d), { state: "linked", url: "https://chat.example.test/app/accounts/2/conversations/41", conversationId: 41, confirmedAt: "2026-10-21T12:00:00.000Z" });
    // ORG_B asking for ORG_A's contact (even with ORG_A's mapping) sees nothing.
    assert.deepEqual(await getChatwootLinkState(ORG_B, CONTACT_A, d), { state: "unavailable" });
  });

  test("a row moved to another workspace's contact by SQL does not verify there (control: still verifies at home)", async () => {
    const d = deps();
    await pool.query(
      "insert into activities (org_id, contact_id, user_id, type, subject, metadata) select $1, $2, $3, type, subject, metadata from activities where contact_id = $4 and type = $5",
      [ORG_B, CONTACT_B, USER_B, CONTACT_A, CHATWOOT_LINK_ACTIVITY_TYPE],
    );
    const [{ n }] = (await pool.query("select count(*)::int as n from activities where contact_id = $1 and type = $2", [CONTACT_B, CHATWOOT_LINK_ACTIVITY_TYPE])).rows;
    assert.equal(n, 1, "the copied row exists");
    assert.deepEqual(await getChatwootLinkState(ORG_B, CONTACT_B, d), { state: "unlinked" });
    assert.equal((await getChatwootLinkState(ORG_A, CONTACT_A, d)).state, "linked");
    void activities;
  });

  test("REPLAY by SQL: after confirming 17, re-inserting the 41 row's metadata for the SAME contact does not revert the link (control: 17 shown before)", async () => {
    const d = deps();
    const asA = { orgId: ORG_A, userId: USER_A, role: "owner", realPerson: true };
    const r = await confirmChatwootLink(asA, { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 17 }, d);
    assert.ok(r.ok, JSON.stringify(r));
    const s1 = await getChatwootLinkState(ORG_A, CONTACT_A, d);
    assert.equal(s1.state === "linked" ? s1.conversationId : null, 17);
    await pool.query(
      "insert into activities (org_id, contact_id, user_id, type, subject, metadata, created_at) select org_id, contact_id, user_id, type, subject, metadata, now() + interval '1 minute' from activities where contact_id = $1 and type = $2 and metadata->>'conversationId' = '41' limit 1",
      [CONTACT_A, CHATWOOT_LINK_ACTIVITY_TYPE],
    );
    const [{ newest }] = (await pool.query("select metadata->>'conversationId' as newest from activities where contact_id = $1 and type = $2 order by created_at desc limit 1", [CONTACT_A, CHATWOOT_LINK_ACTIVITY_TYPE])).rows;
    assert.equal(newest, "41", "the replayed 41 row is the newest row");
    const s2 = await getChatwootLinkState(ORG_A, CONTACT_A, d);
    assert.equal(s2.state === "linked" ? s2.conversationId : null, 17);
  });
});
