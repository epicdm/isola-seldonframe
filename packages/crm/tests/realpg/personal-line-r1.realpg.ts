// EPIC 2026-10-11 - R1 real-Postgres harness: the REAL route handlers and the REAL drizzle stores over a throwaway Postgres 16
// that has had ALL drizzle migrations (0000..0081) applied. Nothing is mocked except the network to plsvc (the card's summary fetch).
//
//   DATABASE_URL=postgres://... DB_DRIVER=pg NEON_LOCAL_HOST=127.0.0.1 ENCRYPTION_KEY=<throwaway> AUTH_SECRET=<throwaway> \
//     npx tsx tests/realpg/personal-line-r1.realpg.ts
//
// With DB_DRIVER=pg + NEON_LOCAL_HOST the app's own "@/db" module is a node-postgres pool (db/index.ts), so every production
// store (link, events, portal-link, secrets, plan gate) runs unchanged. Each negative has its positive twin in the same run.
import assert from "node:assert/strict";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function T(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e: any) { results.push({ name, ok: false, err: String(e?.message ?? e).slice(0, 400) }); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").slice(0, 4).join("\n     ")}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.DATABASE_URL!;
  assert.ok(url, "DATABASE_URL");
  const pool = new Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  console.log("migrations applied");
  const q = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

  const { NextRequest } = await import("next/server");
  const { storeSecret } = await import("../../src/lib/secrets");
  const { signIngress, signPortalLinkRequest } = await import("../../src/lib/personal-line/signing");
  const { POST: eventsPOST } = await import("../../src/app/api/webhooks/personal-line/[orgId]/route");
  const { POST: linkPOST } = await import("../../src/app/api/webhooks/personal-line/[orgId]/portal-link/route");
  const { GET: waGET, POST: waPOST } = await import("../../src/app/customer/[orgSlug]/wa-link/route");
  const { verifyPortalSession, PORTAL_SESSION_COOKIE } = await import("../../src/lib/portal/session");
  const { getPortalSessionForToken } = await import("../../src/lib/portal/auth");
  const { loadPersonalLineCard, productionCardDeps } = await import("../../src/lib/personal-line/card");
  const { hashLinkToken } = await import("../../src/lib/personal-line/portal-link");

  // ── seed: two workspaces, an owner, the Personal Line integration + keys through the app's own storeSecret ──
  const EVKEY1 = "r1-events-key-workspace-one-0123456789abcdef";
  const EVKEY2 = "r1-events-key-workspace-two-0123456789abcdef";
  const SUMKEY = "r1-summary-key-0123456789abcdef-0123456789";
  const [o1] = await q(`insert into organizations (name, slug, plan) values ('PL R1 workspace','pl-r1-ws','growth') returning id`);
  const [o2] = await q(`insert into organizations (name, slug, plan) values ('Other R1 workspace','other-r1-ws','growth') returning id`);
  const [u1] = await q(`insert into users (org_id, name, email) values ($1,'owner one','owner1@example.invalid') returning id`, [o1.id]);
  const [u2] = await q(`insert into users (org_id, name, email) values ($1,'owner two','owner2@example.invalid') returning id`, [o2.id]);
  await q(`update organizations set owner_id=$2 where id=$1`, [o1.id, u1.id]);
  await q(`update organizations set owner_id=$2 where id=$1`, [o2.id, u2.id]);
  const rec = (kid: string) => JSON.stringify({ personalLine: { connected: true, baseUrl: "http://plsvc.invalid:3005/", eventsKeyId: kid, summaryKeyId: "sf1" } });
  await q(`update organizations set integrations=$2::jsonb where id=$1`, [o1.id, rec("ev1")]);
  await q(`update organizations set integrations=$2::jsonb where id=$1`, [o2.id, rec("ev1")]);
  await storeSecret({ workspaceId: o1.id, serviceName: "personal-line-events", value: EVKEY1, actorUserId: u1.id });
  await storeSecret({ workspaceId: o1.id, serviceName: "personal-line-summary", value: SUMKEY, actorUserId: u1.id });
  await storeSecret({ workspaceId: o2.id, serviceName: "personal-line-events", value: EVKEY2, actorUserId: u2.id });
  await storeSecret({ workspaceId: o2.id, serviceName: "personal-line-summary", value: SUMKEY, actorUserId: u2.id });

  const now = () => Math.floor(Date.now() / 1000);
  const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
  const evBody = (id: string, type: string, acc: string, wa: string, version: number, facts: Record<string, unknown> = {}) =>
    JSON.stringify({ event_id: id, type, occurred_at: new Date().toISOString(), version, pl_account_id: acc, wa_id: wa, facts });
  const postEvent = async (orgId: string, body: string, key: string) => {
    const ts = now();
    return eventsPOST(new Request("http://x/e", { method: "POST", body, headers: { "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": signIngress(key, ts, body) } }), ctx(orgId));
  };
  let rid = 0;
  const RID = () => `1b6f2c1e-6a51-4d6e-9d8e-${String(++rid).padStart(12, "0")}`;
  const postLink = async (orgId: string, body: string, o: { key?: string; signer?: (k: string, t: number, b: string) => string; ts?: number } = {}) => {
    const ts = o.ts ?? now();
    const res = await linkPOST(new Request("http://x/l", { method: "POST", body, headers: { "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": (o.signer ?? signPortalLinkRequest)(o.key ?? EVKEY1, ts, body) } }), ctx(orgId));
    return { status: res.status, json: (await res.json()) as any };
  };
  const lb = (acc: string, id = RID()) => JSON.stringify({ request_id: id, pl_account_id: acc });
  const tokenOf = (u: string) => new URL(u).searchParams.get("token")!;
  const waPost = async (slug: string, token: string) => {
    const fd = new FormData(); fd.set("token", token);
    return waPOST(new NextRequest(`http://localhost/customer/${slug}/wa-link`, { method: "POST", body: fd }), { params: Promise.resolve({ orgSlug: slug }) });
  };
  const home = (res: Response) => { const l = res.headers.get("location") ?? ""; return { status: res.status, path: l ? new URL(l).pathname + new URL(l).search : "", cookie: res.headers.get("set-cookie") ?? "" }; };
  const cookieValue = (setCookie: string) => decodeURIComponent((setCookie.match(new RegExp(`${PORTAL_SESSION_COOKIE}=([^;]+)`)) ?? [])[1] ?? "");
  const clearBudget = () => q(`update portal_access_codes set created_at = now() - interval '2 hours' where email = 'wa-link'`);

  // ── S-a: all three new types through the REAL ingress + real stores ──
  const E = (n: number) => `2b6f2c1e-6a51-4d6e-9d8e-${String(n).padStart(12, "0")}`;
  await T("S-a real PG: line_created A and B create two linked contacts (identity rows), 200 processed", async () => {
    for (const [i, acc, wa] of [[1, "accA", "17675550101"], [2, "accB", "17675550102"]] as const) {
      const r = await postEvent(o1.id, evBody(E(i), "pl.line_created", acc, wa, 1, { plan: "trial", trial_end: "2030-01-01T00:00:00Z" }), EVKEY1);
      assert.equal(r.status, 200);
    }
    const ids = await q(`select external_id from external_identities where org_id=$1 order by external_id`, [o1.id]);
    assert.deepEqual(ids.map((x) => x.external_id), ["accA", "accB"]);
  });
  await T("S-a real PG: signup_started / trial_ending / trial_expired -> 200 processed; one activity + one bus row each; trial_end fact merged", async () => {
    const cases: Array<[number, string, Record<string, unknown>]> = [[3, "pl.signup_started", {}], [4, "pl.trial_ending", { trial_end: "2031-01-01T00:00:00Z" }], [5, "pl.trial_expired", { trial_end: "2031-01-01T00:00:00Z" }]];
    let v = 10;
    for (const [n, type, facts] of cases) { const r = await postEvent(o1.id, evBody(E(n), type, "accA", "17675550101", ++v, facts), EVKEY1); assert.equal(r.status, 200, type); }
    const acts = await q(`select a.subject from activities a join external_identities e on e.contact_id=a.contact_id where e.org_id=$1 and e.external_id='accA' and a.type='personal_line' order by a.created_at`, [o1.id]);
    for (const s of ["Personal Line: sign-up started", "Personal Line: trial ending", "Personal Line: trial expired"]) assert.ok(acts.some((a) => a.subject === s), s);
    const log = await q(`select event_type from workflow_event_log where org_id=$1 and event_type in ('pl.signup_started','pl.trial_ending','pl.trial_expired')`, [o1.id]);
    assert.equal(log.length, 3);
    const f = await q(`select facts from integration_subject_facts where org_id=$1 and external_id='accA'`, [o1.id]);
    assert.equal(f[0].facts.trial_end, "2031-01-01T00:00:00Z");
    // twin: the same event again is a duplicate no-op (no second activity)
    const before = (await q(`select count(*)::int n from activities where org_id=$1`, [o1.id]))[0].n;
    const again = await postEvent(o1.id, evBody(E(4), "pl.trial_ending", "accA", "17675550101", 11, { trial_end: "2031-01-01T00:00:00Z" }), EVKEY1);
    assert.equal(((await again.json()) as any).status, "duplicate");
    assert.equal((await q(`select count(*)::int n from activities where org_id=$1`, [o1.id]))[0].n, before);
    // control: an unknown type is still refused with 422
    assert.equal((await postEvent(o1.id, evBody(E(6), "pl.deal_won", "accA", "17675550101", 99), EVKEY1)).status, 422);
    // no deal was created or moved
    assert.equal((await q(`select count(*)::int n from deals where org_id=$1`, [o1.id]))[0].n, 0);
  });

  // ── S-c mint ──
  let linkA = "";
  await T("S-c real PG: signed request for linked accA -> 200 url; token stored as SHA-256 only; portal access enabled for A and NOT for B", async () => {
    const r = await postLink(o1.id, lb("accA"));
    assert.equal(r.status, 200); assert.equal(r.json.ok, true);
    linkA = r.json.url;
    const tok = tokenOf(linkA);
    assert.equal(new URL(linkA).pathname, "/customer/pl-r1-ws/wa-link");
    const rows = await q(`select code_hash, email, used_at, expires_at, contact_id from portal_access_codes where org_id=$1`, [o1.id]);
    assert.equal(rows.length, 1); assert.equal(rows[0].email, "wa-link"); assert.equal(rows[0].code_hash, hashLinkToken(tok)); assert.ok(!JSON.stringify(rows).includes(tok));
    const ttl = (new Date(rows[0].expires_at).getTime() - Date.now()) / 1000;
    assert.ok(ttl > 480 && ttl <= 600, `ttl ${ttl}`);
    const en = await q(`select e.external_id, c.portal_access_enabled en from contacts c join external_identities e on e.contact_id=c.id where c.org_id=$1 order by e.external_id`, [o1.id]);
    assert.deepEqual(en.map((x) => [x.external_id, x.en]), [["accA", true], ["accB", false]]);
  });
  await T("S-c real PG: refusals (positive twin = the mint above): unlinked 404, wrong key 401, event-MAC 401, skew 401, extra key 422, unknown workspace 503, replay 409", async () => {
    assert.equal((await postLink(o1.id, lb("accZZZ"))).status, 404);
    assert.equal((await postLink(o1.id, lb("accB"), { key: EVKEY2 })).status, 401, "workspace two's key on workspace one's path");
    assert.equal((await postLink(o1.id, lb("accB"), { signer: signIngress })).status, 401, "an event MAC opens nothing here");
    assert.equal((await postLink(o1.id, lb("accB"), { ts: now() - 301 })).status, 401);
    assert.equal((await postLink(o1.id, JSON.stringify({ request_id: RID(), pl_account_id: "accB", wa_id: "17675550102" }))).status, 422);
    assert.equal((await postLink("33333333-3333-4333-8333-333333333333", lb("accB"))).status, 503);
    assert.equal((await q(`select count(*)::int n from portal_access_codes where org_id=$1`, [o1.id]))[0].n, 1, "no refused request minted anything");
    const id = RID();
    assert.equal((await postLink(o1.id, lb("accB", id))).status, 200);
    const replay = await postLink(o1.id, lb("accB", id));
    assert.deepEqual([replay.status, replay.json.error], [409, "replayed_request"]);
    assert.equal((await q(`select count(*)::int n from portal_access_codes where org_id=$1 and contact_id=(select contact_id from external_identities where org_id=$1 and external_id='accB')`, [o1.id]))[0].n, 1);
    // workspace two has no link for accA: signed correctly with ITS key, still 404
    assert.equal((await postLink(o2.id, lb("accA"), { key: EVKEY2 })).status, 404);
  });
  await T("S-c real PG: plan gate refuses without minting (twin: restored plan mints); rate limit 3 per contact then 429, other contact unaffected", async () => {
    await clearBudget();
    await q(`update organizations set plan='free' where id=$1`, [o1.id]);
    const before = (await q(`select count(*)::int n from portal_access_codes where org_id=$1`, [o1.id]))[0].n;
    const g = await postLink(o1.id, lb("accA"));
    assert.deepEqual([g.status, g.json.error], [409, "portal_unavailable"]);
    assert.equal((await q(`select count(*)::int n from portal_access_codes where org_id=$1`, [o1.id]))[0].n, before);
    await q(`update organizations set plan='growth' where id=$1`, [o1.id]);
    const urls: string[] = [];
    for (let i = 0; i < 3; i++) { const r = await postLink(o1.id, lb("accA")); assert.equal(r.status, 200); urls.push(r.json.url); }
    const lim = await postLink(o1.id, lb("accA"));
    assert.deepEqual([lim.status, lim.json.error], [429, "rate_limited"]);
    assert.equal((await postLink(o1.id, lb("accB"))).status, 200, "B has her own budget");
    // only the newest of A's links is live
    const live = await q(`select count(*)::int n from portal_access_codes c join external_identities e on e.contact_id=c.contact_id where e.external_id='accA' and c.used_at is null and c.expires_at>now()`);
    assert.equal(live[0].n, 1);
    linkA = urls[2];
  });

  // ── S-c redeem ──
  await T("S-c real PG: GET is an interstitial and does NOT consume; POST consumes once (303 Home + signed cookie for contact A); second POST refused", async () => {
    const tok = tokenOf(linkA);
    const g = await waGET(new NextRequest(`http://localhost/customer/pl-r1-ws/wa-link?token=${tok}`), { params: Promise.resolve({ orgSlug: "pl-r1-ws" }) });
    assert.equal(g.status, 200); assert.match(await g.text(), /method="post"/);
    assert.equal((await q(`select used_at from portal_access_codes where code_hash=$1`, [hashLinkToken(tok)]))[0].used_at, null, "a GET (preview/prefetch) did not spend the link");
    const p = home(await waPost("pl-r1-ws", tok));
    assert.equal(p.status, 303); assert.equal(p.path, "/customer/pl-r1-ws");
    const cookie = cookieValue(p.cookie);
    const sess = verifyPortalSession(cookie);
    const contactA = (await q(`select contact_id from external_identities where org_id=$1 and external_id='accA'`, [o1.id]))[0].contact_id;
    assert.equal(sess?.contactId, contactA); assert.equal(sess?.orgId, o1.id);
    const real = await getPortalSessionForToken("pl-r1-ws", cookie);
    assert.equal(real?.contact.id, contactA, "the app's own portal session resolver accepts it");
    assert.ok((await q(`select portal_last_login_at from contacts where id=$1`, [contactA]))[0].portal_last_login_at);
    assert.ok((await q(`select 1 from workflow_event_log where org_id=$1 and event_type='portal.login'`, [o1.id])).length >= 1);
    const again = home(await waPost("pl-r1-ws", tok));
    assert.equal(again.path, "/customer/pl-r1-ws/login?error=invalid_magic_link"); assert.equal(again.cookie, "");
  });
  await T("S-c real PG: concurrent redemption of one link -> exactly one winner (atomic UPDATE .. RETURNING)", async () => {
    await clearBudget();
    const tok = tokenOf((await postLink(o1.id, lb("accA"))).json.url);
    const rs = await Promise.all(Array.from({ length: 8 }, () => waPost("pl-r1-ws", tok)));
    const outs = rs.map(home);
    assert.equal(outs.filter((o) => o.path === "/customer/pl-r1-ws").length, 1);
    assert.equal(outs.filter((o) => o.path.includes("invalid_magic_link")).length, 7);
  });
  await T("S-c real PG: expiry refused (twin: in-window works); wrong workspace slug refused; tampered/short token refused", async () => {
    await clearBudget();
    const t1 = tokenOf((await postLink(o1.id, lb("accA"))).json.url);
    await q(`update portal_access_codes set expires_at = now() - interval '1 second' where code_hash=$1`, [hashLinkToken(t1)]);
    assert.ok(home(await waPost("pl-r1-ws", t1)).path.includes("invalid_magic_link"), "expired");
    const t2 = tokenOf((await postLink(o1.id, lb("accA"))).json.url);
    assert.ok(home(await waPost("other-r1-ws", t2)).path.includes("invalid_magic_link"), "other workspace slug");
    assert.ok(home(await waPost("pl-r1-ws", t2.slice(0, 42) + (t2.endsWith("A") ? "B" : "A"))).path.includes("invalid_magic_link"), "tampered");
    assert.ok(home(await waPost("pl-r1-ws", "short")).path.includes("invalid_magic_link"));
    assert.equal(home(await waPost("pl-r1-ws", t2)).path, "/customer/pl-r1-ws", "TWIN: the untouched in-window token works");
  });
  await T("S-c real PG: CROSS-CONTACT - A's link opens A only, B's opens B only, and each session sees only its own card (card fails closed otherwise)", async () => {
    await clearBudget();
    const ta = tokenOf((await postLink(o1.id, lb("accA"))).json.url);
    const tb = tokenOf((await postLink(o1.id, lb("accB"))).json.url);
    const ca = verifyPortalSession(cookieValue(home(await waPost("pl-r1-ws", ta)).cookie))!;
    const cb = verifyPortalSession(cookieValue(home(await waPost("pl-r1-ws", tb)).cookie))!;
    const map = await q(`select external_id, contact_id from external_identities where org_id=$1`, [o1.id]);
    const of = (acc: string) => map.find((m) => m.external_id === acc)!.contact_id;
    assert.equal(ca.contactId, of("accA")); assert.equal(cb.contactId, of("accB")); assert.notEqual(ca.contactId, cb.contactId);
    const asked: string[] = [];
    const real = await productionCardDeps(o1.id);
    const env = (acc: string, did: string, mins: number) => ({ status: "ok", code: "account_summary", request_id: null, data: { account: acc, did, plan: "trial", plan_name: "Free trial", plan_end: "2031-01-01T00:00:00Z", minutes_left: mins, minutes_included: 60, balance_known: true, wallet: { currency: "XCD", amount: "1.00" }, setup_state: "registered" } });
    const deps = { findAccountForContact: real.findAccountForContact, fetchSummary: async (acc: string) => { asked.push(acc); return acc === "accA" ? env("accA", "+1 767 818 5001", 41) : env("accB", "+1 767 818 5002", 52); } };
    const cardA = await loadPersonalLineCard({ orgId: o1.id, contact: { id: ca.contactId } }, deps);
    const cardB = await loadPersonalLineCard({ orgId: o1.id, contact: { id: cb.contactId } }, deps);
    assert.equal(cardA.kind === "ok" && cardA.summary.did, "+1 767 818 5001"); assert.equal(cardB.kind === "ok" && cardB.summary.did, "+1 767 818 5002");
    assert.deepEqual(asked, ["accA", "accB"]);
    // fail closed: plsvc unreachable (the real fetcher to plsvc.invalid) -> error card, never another account's data
    const down = await loadPersonalLineCard({ orgId: o1.id, contact: { id: ca.contactId } }, real);
    assert.equal(down.kind, "error");
    // a self-entered contact with A's phone never gets a card (control: A did)
    const [c] = await q(`insert into contacts (org_id, first_name, phone, email, source, portal_access_enabled) values ($1,'Form','+17675550101','form@example.invalid','manual',true) returning id`, [o1.id]);
    assert.deepEqual(await loadPersonalLineCard({ orgId: o1.id, contact: { id: c.id } }, deps), { kind: "none" });
  });
  await T("S-c real PG: a link dies with its identity (identity row removed after minting -> refused; contact itself untouched)", async () => {
    await clearBudget();
    const t = tokenOf((await postLink(o1.id, lb("accB"))).json.url);
    const [idrow] = await q(`delete from external_identities where org_id=$1 and external_id='accB' returning contact_id`, [o1.id]);
    assert.ok(home(await waPost("pl-r1-ws", t)).path.includes("invalid_magic_link"));
    assert.equal((await q(`select count(*)::int n from contacts where id=$1`, [idrow.contact_id]))[0].n, 1);
    assert.equal((await postLink(o1.id, lb("accB"))).status, 404, "and no new link can be minted for the unlinked account");
  });

  await pool.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nREALPG TOTAL ${results.length} PASS ${results.length - failed.length} FAIL ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR", e?.stack ?? e); process.exit(2); });
