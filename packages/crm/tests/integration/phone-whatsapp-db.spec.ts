// Database-backed ownership proof for Phone & WhatsApp: the REAL link store (drizzle -> neon-http driver -> Postgres, jsonb
// containment query) behind the REAL service, with test workspaces written into a SCRATCH database only.
//
// Opt-in. It refuses to run unless the app is pointed at a self-host Neon proxy (NEON_LOCAL_HOST) AND the caller sets
// PHONE_WHATSAPP_DB_TEST=scratch, so it cannot touch a production database. Run it with: node --import tsx --test <this file>
// The scratch database needs only a minimal `organizations (id uuid pk, name text, slug text unique, settings jsonb)` table.
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.PHONE_WHATSAPP_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

// Synthetic ids unless the harness supplies real ones (so a live evidence service can answer for the authorized example).
const WABA = process.env.PHONE_TEST_WABA_ID ?? "100000000000001";
const PHONE_A = process.env.PHONE_TEST_PHONE_ID_A ?? "200000000000001";
const PHONE_D = process.env.PHONE_TEST_PHONE_ID_D ?? "200000000000002";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001"; // owns PHONE_A
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002"; // no links at all
const ORG_C = "cccccccc-0000-4000-8000-000000000003"; // claims PHONE_A too (conflict), created mid-test
const ORG_D = "dddddddd-0000-4000-8000-000000000004"; // owns PHONE_D
const ORG_E = "eeeeeeee-0000-4000-8000-000000000005"; // malformed settings

const lines = (...l: { phoneNumberId: string; wabaId: string; label?: string }[]) => ({ phoneWhatsapp: { lines: l } });

describe("Phone & WhatsApp: database-backed workspace ownership", { skip: !enabled && "set PHONE_WHATSAPP_DB_TEST=scratch with a scratch NEON_LOCAL_HOST database" }, () => {
  let db: typeof import("@/db").db;
  let loadPhoneWhatsappView: typeof import("@/lib/phone-whatsapp/service").loadPhoneWhatsappView;
  let getServiceDeps: typeof import("@/lib/phone-whatsapp/server").getServiceDeps;
  let providerCalls: string[] = [];

  const deps = () => {
    const real = getServiceDeps(); // real DB-backed store; real evidence provider (the adapter) if configured
    return { ...real, provider: async (l: Parameters<typeof real.provider>[0]) => (providerCalls.push(l.phoneNumberId), real.provider(l)) };
  };
  const put = (id: string, name: string, settings: unknown) =>
    db.execute(sql`insert into organizations (id, name, slug, settings) values (${id}::uuid, ${name}, ${name}, ${JSON.stringify(settings)}::jsonb)
                   on conflict (id) do update set settings = excluded.settings`);

  before(async () => {
    ({ db } = await import("@/db"));
    ({ loadPhoneWhatsappView } = await import("@/lib/phone-whatsapp/service"));
    ({ getServiceDeps } = await import("@/lib/phone-whatsapp/server"));
    delete process.env.PHONE_WHATSAPP_LINK_SOURCE; // the DB store, never the env demo store
    // Remove any leftovers of a previous run (scratch DB only; guarded by `enabled`).
    await db.execute(sql`delete from organizations where id in (${ORG_A}::uuid, ${ORG_B}::uuid, ${ORG_C}::uuid, ${ORG_D}::uuid, ${ORG_E}::uuid)`);
    await put(ORG_A, "test-ws-a", lines({ wabaId: WABA, phoneNumberId: PHONE_A, label: "A line" }));
    await put(ORG_B, "test-ws-b", {});
    await put(ORG_D, "test-ws-d", lines({ wabaId: WABA, phoneNumberId: PHONE_D, label: "D line" }));
    await put(ORG_E, "test-ws-e", { phoneWhatsapp: { lines: "not-a-list" } });
  });

  test("POSITIVE CONTROL: the owner workspace gets its own line, read through the database store", async () => {
    providerCalls = [];
    const v = await loadPhoneWhatsappView(ORG_A, deps());
    assert.equal(v.kind, "lines");
    if (v.kind !== "lines") return;
    assert.deepEqual(v.lines.map((l) => l.phoneNumberId), [PHONE_A]);
    assert.deepEqual(providerCalls, [PHONE_A]);
  });

  test("another workspace with no link sees no_link, contains none of A's ids, and no evidence is requested", async () => {
    providerCalls = [];
    const v = await loadPhoneWhatsappView(ORG_B, deps());
    assert.equal(v.kind, "no_link");
    const s = JSON.stringify(v);
    for (const secret of [PHONE_A, PHONE_D, WABA, "A line"]) assert.ok(!s.includes(secret));
    assert.deepEqual(providerCalls, []);
  });

  test("a different workspace with its own line sees only its own line (A's number never requested or shown)", async () => {
    providerCalls = [];
    const v = await loadPhoneWhatsappView(ORG_D, deps());
    assert.equal(v.kind, "lines");
    assert.deepEqual(providerCalls, [PHONE_D]);
    assert.ok(!JSON.stringify(v).includes(PHONE_A));
  });

  test("malformed settings fail closed to no_link", async () => {
    const v = await loadPhoneWhatsappView(ORG_E, deps());
    assert.equal(v.kind, "no_link");
  });

  test("an unknown workspace id sees no_link", async () => {
    const v = await loadPhoneWhatsappView("ffffffff-0000-4000-8000-0000000000ff", deps());
    assert.equal(v.kind, "no_link");
  });

  test("two workspaces claiming one number: BOTH are refused and no evidence is requested; removing the second claim restores the first", async () => {
    await put(ORG_C, "test-ws-c", lines({ wabaId: WABA, phoneNumberId: PHONE_A }));
    providerCalls = [];
    const a = await loadPhoneWhatsappView(ORG_A, deps());
    const c = await loadPhoneWhatsappView(ORG_C, deps());
    assert.equal(a.kind, "link_conflict");
    assert.equal(c.kind, "link_conflict");
    assert.deepEqual(providerCalls, []);
    assert.ok(!JSON.stringify(c).includes(WABA));
    await put(ORG_C, "test-ws-c", {});
    const again = await loadPhoneWhatsappView(ORG_A, deps());
    assert.equal(again.kind, "lines"); // control: the refusal above was the conflict, not a broken harness
  });
});
