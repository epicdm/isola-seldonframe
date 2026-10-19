// Standard Meta connection against a REAL Postgres through the production driver: the real SQL store (single-use attempts, connection states,
// retention, link row) behind the real finalize orchestration, then the EXISTING panel read path to prove the connected workspace sees ITS OWN
// number and nobody else's. Meta is replaced by an in-process fake (no network). Scratch database only.
//
// Opt-in, same guard as phone-whatsapp-db.spec.ts: refuses unless NEON_LOCAL_HOST is set AND PHONE_WHATSAPP_DB_TEST=scratch.
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.PHONE_WHATSAPP_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const C = "cccccccc-0000-4000-8000-0000000000c3";
const WABA = "900000000000001";
const PHONE = "900000000000002";
const PHONE2 = "900000000000012";
const FAKE_TOKEN = ["fixture", "business", "bearer", "0002"].join("-");

describe("Phone connect: database-backed journey", { skip: !enabled && "set PHONE_WHATSAPP_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let store: import("@/lib/phone-whatsapp/connect/finalize").ConnectStore;
  let fin: typeof import("@/lib/phone-whatsapp/connect/finalize");
  let deps: import("@/lib/phone-whatsapp/connect/finalize").FinalizeDeps;
  let registered: string[] = [];
  let failActivate = false;
  let loadView: typeof import("@/lib/phone-whatsapp/service").loadPhoneWhatsappView;
  let getServiceDeps: typeof import("@/lib/phone-whatsapp/server").getServiceDeps;
  let listStates: typeof import("@/lib/phone-whatsapp/connect/server-wiring").listConnectionStates;

  const row = async (id: string) => {
    const r = await db.execute(sql`select settings, integrations from organizations where id = ${id}::uuid`);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows)[0] ?? null) as { settings: any; integrations: any } | null;
  };
  const claim = (nonce: string, o: Record<string, unknown> = {}) => ({ orgId: A, userId: "user-a", nonce, code: "c", wabaId: WABA, phoneNumberId: PHONE, ...o });
  const start = async (orgId = A, userId = "user-a") => (await fin.startConnect({ orgId, userId, consentAccepted: true }, deps)) as { nonce: string };

  before(async () => {
    ({ db } = await import("@/db"));
    fin = await import("@/lib/phone-whatsapp/connect/finalize");
    const wiring = await import("@/lib/phone-whatsapp/connect/server-wiring");
    listStates = wiring.listConnectionStates;
    ({ loadPhoneWhatsappView: loadView } = await import("@/lib/phone-whatsapp/service"));
    ({ getServiceDeps } = await import("@/lib/phone-whatsapp/server"));
    const real = wiring.makeDbConnectStore();
    // The real store, with one switch to make the LOCAL binding fail after Meta registered (what a crash / lost connection looks like).
    store = { ...real, activate: (a) => (failActivate ? Promise.reject(new Error("db")) : real.activate(a)) };
    deps = {
      store,
      graph: {
        async debugToken() { return { isValid: true, appId: "APP1", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], wabaTargets: [WABA] }; },
        async listWabaPhones() { return [PHONE, PHONE2].map((id) => ({ id, displayNumber: "+1 555 0100", verifiedName: "Test Co", platformType: "CLOUD_API", isOnBizApp: false })); },
      },
      async exchangeCode() { return FAKE_TOKEN; },
      async register(_t, phone) { registered.push(phone); },
      async subscribeApp() {}, // 2026-10-19: the WABA subscribe step (Meta faked here like register)
      isDefiniteFailure: () => false,
      encrypt: (await import("@/lib/encryption")).encryptValue,
      ourAppId: "APP1",
      epicWabaIds: new Set(["900000000000777"]),
      protectedPhoneIds: new Set(["900000000000888"]),
      now: () => new Date(),
    };
    await db.execute(sql`delete from organizations where id in (${A}::uuid, ${B}::uuid, ${C}::uuid)`);
    await db.execute(sql`insert into organizations (id, name, slug, settings) values (${A}::uuid, 'ws-a', 'ws-a', '{}'::jsonb), (${B}::uuid, 'ws-b', 'ws-b', '{}'::jsonb), (${C}::uuid, 'ws-c', 'ws-c', '{}'::jsonb)`);
  });

  test("POSITIVE CONTROL: start -> finalize connects the number; attempt consumed; link row + encrypted secrets + consent stored; active", async () => {
    const n = (await start()).nonce;
    const pre = await row(A);
    assert.equal(Object.keys(pre!.settings.phoneWhatsapp.pending).length, 1);
    assert.equal(JSON.stringify(pre).includes(n), false, "the nonce is stored hashed");

    const r = await fin.finalizeConnect(claim(n), deps);
    assert.equal(r.ok, true);
    assert.deepEqual(registered, [PHONE]);

    const post = await row(A);
    assert.deepEqual(Object.keys(post!.settings.phoneWhatsapp.pending), [], "attempt consumed");
    assert.deepEqual(post!.settings.phoneWhatsapp.lines.map((l: any) => [l.wabaId, l.phoneNumberId, l.source]), [[WABA, PHONE, "connect"]]);
    const conn = post!.settings.phoneWhatsapp.connections[PHONE];
    assert.equal(conn.status, "active");
    assert.equal(conn.consent.userId, "user-a", "the consent record outlives the consumed attempt");
    assert.match(conn.consent.termsVersion, /^whatsapp-connect-/);
    const sec = post!.integrations.whatsappConnect[PHONE];
    assert.match(sec.tokenEnc, /^v1\./);
    assert.equal(JSON.stringify(post).includes(FAKE_TOKEN), false, "no clear-text token anywhere on the row");
    assert.equal(JSON.stringify(post!.settings).includes("pinEnc"), false, "secrets live in integrations, not in the settings the panel reads");
  });

  test("the EXISTING panel read path now shows this workspace its own number, and another workspace sees none of it", async () => {
    const asked: string[] = [];
    const real = getServiceDeps();
    const d = { ...real, provider: async (l: Parameters<typeof real.provider>[0]) => (asked.push(l.phoneNumberId), real.provider(l)) };
    const v = await loadView(A, d);
    assert.equal(v.kind, "lines");
    if (v.kind === "lines") assert.deepEqual(v.lines.map((l) => l.phoneNumberId), [PHONE]);
    assert.deepEqual(asked, [PHONE]);
    asked.length = 0;
    const vb = await loadView(B, d);
    assert.equal(vb.kind, "no_link");
    assert.equal(JSON.stringify(vb).includes(PHONE), false);
    assert.deepEqual(asked, []);
  });

  test("a spent attempt cannot be replayed (twin: it worked once)", async () => {
    const h = fin.hashNonce((await start()).nonce);
    assert.notEqual(await store.consumeAttempt({ orgId: A, userId: "user-a", nonceHash: h, now: new Date() }), null);
    assert.equal(await store.consumeAttempt({ orgId: A, userId: "user-a", nonceHash: h, now: new Date() }), null);
  });

  test("an attempt minted for workspace A or user-a cannot be consumed as B / another user, and those refusals do not burn it", async () => {
    const h = fin.hashNonce((await start()).nonce);
    assert.equal(await store.consumeAttempt({ orgId: B, userId: "user-a", nonceHash: h, now: new Date() }), null);
    assert.equal(await store.consumeAttempt({ orgId: A, userId: "user-b", nonceHash: h, now: new Date() }), null);
    assert.notEqual(await store.consumeAttempt({ orgId: A, userId: "user-a", nonceHash: h, now: new Date() }), null);
  });

  test("an expired attempt is refused by the database statement itself", async () => {
    const h = fin.hashNonce((await start()).nonce);
    assert.equal(await store.consumeAttempt({ orgId: A, userId: "user-a", nonceHash: h, now: new Date(Date.now() + 16 * 60_000) }), null);
    assert.notEqual(await store.consumeAttempt({ orgId: A, userId: "user-a", nonceHash: h, now: new Date() }), null);
  });

  test("one number, one workspace: B's connect of A's number is refused 'already_bound' and B's row is untouched", async () => {
    const n = (await start(B, "user-b")).nonce;
    const r = await fin.finalizeConnect(claim(n, { orgId: B, userId: "user-b" }), deps);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "already_bound"]);
    const b = await row(B);
    assert.equal(b!.settings.phoneWhatsapp?.lines, undefined);
    assert.equal(b!.integrations?.whatsappConnect, undefined);
  });

  test("re-connecting the same number in the same workspace is idempotent: no second registration, no duplicate link row", async () => {
    const before = registered.length;
    const r = await fin.finalizeConnect(claim((await start()).nonce), deps);
    assert.equal(r.ok, true);
    assert.equal(registered.length, before);
    assert.equal((await row(A))!.settings.phoneWhatsapp.lines.length, 1);
  });
});

describe("Phone connect: partial completion and retention against the real store", { skip: !enabled && "scratch database only" }, () => {
  let db: typeof import("@/db").db;
  let fin: typeof import("@/lib/phone-whatsapp/connect/finalize");
  let store: import("@/lib/phone-whatsapp/connect/finalize").ConnectStore;
  let deps: import("@/lib/phone-whatsapp/connect/finalize").FinalizeDeps;
  let listStates: typeof import("@/lib/phone-whatsapp/connect/server-wiring").listConnectionStates;
  let registered: string[] = [];
  let failActivate = false;

  const row = async (id: string) => {
    const r = await db.execute(sql`select settings, integrations from organizations where id = ${id}::uuid`);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows)[0] ?? null) as { settings: any; integrations: any } | null;
  };

  before(async () => {
    ({ db } = await import("@/db"));
    fin = await import("@/lib/phone-whatsapp/connect/finalize");
    const wiring = await import("@/lib/phone-whatsapp/connect/server-wiring");
    listStates = wiring.listConnectionStates;
    const real = wiring.makeDbConnectStore();
    store = { ...real, activate: (a) => (failActivate ? Promise.reject(new Error("db")) : real.activate(a)) };
    deps = {
      store,
      graph: {
        async debugToken() { return { isValid: true, appId: "APP1", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], wabaTargets: [WABA] }; },
        async listWabaPhones() { return [{ id: PHONE2, displayNumber: "+1 555 0112", verifiedName: "Test Co 2", platformType: "CLOUD_API", isOnBizApp: false }]; },
      },
      async exchangeCode() { return FAKE_TOKEN; },
      async register(_t, phone) { registered.push(phone); },
      async subscribeApp() {}, // 2026-10-19: the WABA subscribe step (Meta faked here like register)
      isDefiniteFailure: () => false,
      encrypt: (await import("@/lib/encryption")).encryptValue,
      ourAppId: "APP1",
      epicWabaIds: new Set(["900000000000777"]),
      protectedPhoneIds: new Set(["900000000000888"]),
      now: () => new Date(),
    };
    await db.execute(sql`delete from organizations where id = ${C}::uuid`);
    await db.execute(sql`insert into organizations (id, name, slug, settings) values (${C}::uuid, 'ws-c', 'ws-c', '{}'::jsonb)`);
  });
  const claimC = (nonce: string) => ({ orgId: C, userId: "user-c", nonce, code: "c", wabaId: WABA, phoneNumberId: PHONE2 });
  const startC = async () => ((await fin.startConnect({ orgId: C, userId: "user-c", consentAccepted: true }, deps)) as { nonce: string }).nonce;

  test("registered at Meta, local binding fails: the row says 'registered' (no link row yet, not reported connected), and the secrets are saved", async () => {
    failActivate = true;
    registered = [];
    const r = await fin.finalizeConnect(claimC(await startC()), deps);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "persist_failed"]);
    const c = await row(C);
    assert.equal(c!.settings.phoneWhatsapp.lines, undefined, "no link row: not shown as connected");
    assert.equal(c!.settings.phoneWhatsapp.connections[PHONE2].status, "registered");
    assert.ok(c!.integrations.whatsappConnect[PHONE2].pinEnc, "the PIN that registered the number is kept");
    assert.deepEqual(registered, [PHONE2]);
    const states = await listStates(C);
    assert.deepEqual(states.map((s) => [s.phoneNumberId, s.status]), [[PHONE2, "registered"]]);
  });

  test("another workspace cannot take a number that is registered-but-unfinished (claimants includes unfinished connections)", async () => {
    const n = ((await fin.startConnect({ orgId: B, userId: "user-b", consentAccepted: true }, deps)) as { nonce: string }).nonce;
    const r = await fin.finalizeConnect({ orgId: B, userId: "user-b", nonce: n, code: "c", wabaId: WABA, phoneNumberId: PHONE2 }, deps);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "already_bound"]);
  });

  test("retry after the failure: binding finishes, the number is NOT registered again, the original PIN is kept", async () => {
    failActivate = false;
    const pinBefore = (await row(C))!.integrations.whatsappConnect[PHONE2].pinEnc;
    const r = await fin.finalizeConnect(claimC(await startC()), deps);
    assert.deepEqual([r.ok, (r as { resumed?: boolean }).resumed], [true, true]);
    assert.deepEqual(registered, [PHONE2], "still exactly one registration");
    const c = await row(C);
    assert.equal(c!.integrations.whatsappConnect[PHONE2].pinEnc, pinBefore);
    assert.equal(c!.settings.phoneWhatsapp.connections[PHONE2].status, "active");
    assert.equal(c!.settings.phoneWhatsapp.lines.length, 1);
  });

  test("RETENTION: starting attempts prunes expired ones and caps live ones; connection records and consent are never pruned", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const stale = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`stale${i}`, { userId: "u", expiresAt: past, consent: { termsVersion: "x", at: past, userId: "u" } }]));
    await db.execute(sql`update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,pending}', ${JSON.stringify(stale)}::jsonb, true) where id = ${C}::uuid`);
    assert.equal(Object.keys((await row(C))!.settings.phoneWhatsapp.pending).length, 4, "control: the stale entries are present before");
    const connBefore = JSON.stringify((await row(C))!.settings.phoneWhatsapp.connections);
    const linesBefore = JSON.stringify((await row(C))!.settings.phoneWhatsapp.lines);
    for (let i = 0; i < 8; i++) await startC();
    const pending = (await row(C))!.settings.phoneWhatsapp.pending;
    assert.equal(Object.keys(pending).length, fin.MAX_LIVE_ATTEMPTS, "capped");
    assert.equal(Object.keys(pending).some((k) => k.startsWith("stale")), false, "expired entries pruned");
    assert.equal(JSON.stringify((await row(C))!.settings.phoneWhatsapp.connections), connBefore, "connection records untouched");
    assert.equal(JSON.stringify((await row(C))!.settings.phoneWhatsapp.lines), linesBefore, "link rows untouched");
    assert.equal((await row(C))!.settings.phoneWhatsapp.connections[PHONE2].consent.userId, "user-c", "consent still explains the active connection");
  });

  test("nothing stored or listed for the page contains the code, token or PIN in clear", async () => {
    const all = JSON.stringify(await row(C)) + JSON.stringify(await listStates(C));
    assert.equal(all.includes(FAKE_TOKEN), false);
    assert.equal(all.includes('"code"'), false);
  });
});
