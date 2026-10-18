// The service stores against a REAL Postgres through the production driver (scratch database only; same opt-in guard as the other phone DB specs).
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.PHONE_WHATSAPP_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;
const WS = "aaaaaaaa-0000-4000-8000-0000000000c1";
const WS2 = "bbbbbbbb-0000-4000-8000-0000000000c2";
const PHONE = "900000000000502";

describe("service stores (database-backed)", { skip: !enabled && "scratch database only" }, () => {
  let db: typeof import("@/db").db;
  let st: typeof import("@/lib/phone-whatsapp/service/stores");
  const settings = async (id: string) => {
    const r = await db.execute(sql`select settings from organizations where id = ${id}::uuid`);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows)[0] as { settings: any }).settings;
  };
  before(async () => {
    ({ db } = await import("@/db")); st = await import("@/lib/phone-whatsapp/service/stores");
    await db.execute(sql`delete from organizations where id in (${WS}::uuid, ${WS2}::uuid)`);
    await db.execute(sql`insert into organizations (id, name, slug, settings) values (${WS}::uuid, 'svc-a', 'svc-a', '{}'::jsonb), (${WS2}::uuid, 'svc-b', 'svc-b', '{"phoneWhatsapp":{"lines":[{"wabaId":"900000000000001","phoneNumberId":"900000000000502"}]}}'::jsonb)`);
  });

  test("ledger lease is a compare-and-set: of two simultaneous begins exactly one wins; after the lease expires another may begin; steps and finish are recorded", async () => {
    const ledger = st.makeAttachLedger(); const now = new Date();
    const a = { workspaceId: WS, phoneNumberId: PHONE, idempotencyKey: "k", destinationId: "d1", now, leaseMs: 60_000 };
    const [x, y] = await Promise.all([ledger.begin(a), ledger.begin(a)]);
    assert.deepEqual([x, y].sort(), [false, true]);
    assert.equal(await ledger.begin(a), false, "still leased");
    await ledger.recordStep({ workspaceId: WS, phoneNumberId: PHONE, step: "service_account", rec: { done: true, ref: "acct-1" } });
    assert.equal(await ledger.begin({ ...a, now: new Date(now.getTime() + 61_000) }), true, "expired lease can be taken");
    const rec = await ledger.get(WS, PHONE);
    assert.equal(rec!.steps.service_account!.ref, "acct-1", "steps survive a new lease");
    await ledger.finish({ workspaceId: WS, phoneNumberId: PHONE, status: "attached" });
    const done = await ledger.get(WS, PHONE);
    assert.deepEqual([done!.status, done!.leaseUntil], ["attached", null]);
    assert.equal(await ledger.begin({ ...a, now: new Date(now.getTime() + 62_000) }), true, "a finished record is not leased");
  });

  test("the ledger of one workspace is invisible to another and a write to a missing ledger row fails loudly", async () => {
    const ledger = st.makeAttachLedger();
    assert.equal(await ledger.get(WS2, PHONE), null);
    await assert.rejects(ledger.recordStep({ workspaceId: WS2, phoneNumberId: PHONE, step: "did", rec: { done: true } }));
  });

  test("call events and acceptance keep the newest N in time order (oldest first), per number", async () => {
    for (let i = 1; i <= 25; i++) await st.appendCallEvent(WS, PHONE, { callId: `c${i}`, phoneNumberId: PHONE, at: new Date(1_800_000_000_000 + i * 1000).toISOString() });
    const ev = await st.readCallEvents(WS, PHONE);
    assert.equal(ev.length, 20);
    assert.deepEqual([ev[0].callId, ev.at(-1)!.callId], ["c6", "c25"]);
    assert.deepEqual(await st.readCallEvents(WS, "900000000000099"), []);
  });

  test("destination catalog and agent registry are read from the workspace's own row only", async () => {
    await db.execute(sql`update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,destinations}', '[{"id":"d1","label":"Q","kind":"pbx_queue","target":{"trunk":"t","ext":"1"},"workspaceId":"x","status":"active"}]'::jsonb, true) where id = ${WS}::uuid`);
    await db.execute(sql`update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,agents}', '[{"ref":"agent-1"}]'::jsonb, true) where id = ${WS}::uuid`);
    assert.equal((await st.readDestinationCatalog(WS)).length, 1);
    assert.equal((await st.readDestinationCatalog(WS2)).length, 0);
    assert.equal(await st.makeAgentDirectory().exists("agent-1", WS), true);
    assert.equal(await st.makeAgentDirectory().exists("agent-1", WS2), false);
  });

  test("claimants: a number linked in one workspace is reported for that workspace only; no secrets live under the settings the stores write", async () => {
    assert.deepEqual(await st.claimantsOf(PHONE), [WS2]);
    assert.equal(JSON.stringify(await settings(WS)).match(/secret|token|password/i), null);
  });
});
