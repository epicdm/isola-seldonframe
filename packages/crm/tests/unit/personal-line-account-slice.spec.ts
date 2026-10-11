// EPIC 2026-10-11 — Personal Line subscriber account slice (2a).
// Every negative has its positive twin in the same run (Law 19). Fakes key ONLY on the subject they are asked about,
// so if the code ever asked about the wrong contact/account the wrong data would come back and these tests would see it.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signIngress, signSummaryRequest, verifyIngress } from "../../src/lib/personal-line/signing";
import { resolvePersonalLine, validatePersonalLineSettings, PL_SECRET_EVENTS, PL_SECRET_SUMMARY } from "../../src/lib/personal-line/integration";
import { linkPersonalLine, PL_PROVIDER, type LinkStore } from "../../src/lib/personal-line/link";
import { loadPersonalLineCard, makeSummaryFetcher, parseSummaryEnvelope, type CardDeps } from "../../src/lib/personal-line/card";
import { handlePersonalLineWebhook, parsePlEvent, processPlEvent, PL_EVENT_TYPES, type Emit, type EventStore } from "../../src/lib/personal-line/events";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const KEY = { kid: "ev1", key: "events-unit-key-0123456789abcdef-01234" };
const SKEY = "summary-unit-key-0123456789abcdef-0123";
const now = () => Math.floor(Date.now() / 1000);
const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const ORG = "11111111-1111-4111-8111-111111111111";

// ── in-memory store that behaves like the two unique indexes ─────────────────
function memStore() {
  const contacts = new Map<string, { orgId: string; firstName: string; phone: string | null; email: string | null; source: string | null }>();
  const ids: Array<{ orgId: string; provider: string; externalId: string; contactId: string }> = [];
  let n = 0;
  const store: LinkStore = {
    async findIdentityByExternal(o, p, e) { const r = ids.find((x) => x.orgId === o && x.provider === p && x.externalId === e); return r ? { contactId: r.contactId } : null; },
    async contactExists(o, c) { return contacts.get(c)?.orgId === o; },
    async setContactPhone(o, c, phone) { const x = contacts.get(c); if (x && x.orgId === o) x.phone = phone; },
    async createContact(o, c) { const id = `c${++n}`; contacts.set(id, { orgId: o, firstName: c.firstName, phone: c.phone, email: null, source: c.source }); return id; },
    async insertIdentity(o, p, e, c) {
      if (ids.some((x) => x.orgId === o && x.provider === p && (x.externalId === e || x.contactId === c))) return false;
      ids.push({ orgId: o, provider: p, externalId: e, contactId: c }); return true;
    },
    async deleteContact(o, c) { if (contacts.get(c)?.orgId === o) contacts.delete(c); },
  };
  /** what an intake form / chat / operator does: a contact with a SELF-ENTERED phone and email, never an identity */
  const intakeContact = (o: string, phone: string, email: string) => { const id = `c${++n}`; contacts.set(id, { orgId: o, firstName: "Form", phone, email, source: "intake" }); return id; };
  const cardDeps = (summaries: Record<string, unknown>, asked: string[] = []): CardDeps => ({
    async findAccountForContact(o, c) { return ids.find((x) => x.orgId === o && x.provider === PL_PROVIDER && x.contactId === c)?.externalId ?? null; },
    async fetchSummary(acc) { asked.push(acc); return summaries[acc]; },
  });
  return { store, contacts, ids, intakeContact, cardDeps };
}
const env = (acc: string, did: string, minutes: number, amount: string) => ({
  status: "ok", code: "account_summary", request_id: null,
  data: { account: acc, did, plan: "trial", plan_name: "Free trial", plan_end: "2026-10-18T04:00:00.000Z", minutes_left: minutes,
    minutes_included: 60, balance_known: true, wallet: { currency: "XCD", amount }, setup_state: "registered" },
});

// ── ingress signature ────────────────────────────────────────────────────────
test("ingress: unsigned / wrong key / wrong kid / old / future / tampered body are refused; the correctly signed one is accepted", () => {
  const body = JSON.stringify({ pl_account_id: "accA", wa_id: "17675550101" });
  const ts = now();
  const good = { "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": signIngress(KEY.key, ts, body) };
  assert.deepEqual(verifyIngress(H(good), body, KEY, ts), { ok: true });                                   // POSITIVE TWIN
  assert.deepEqual(verifyIngress(H({}), body, KEY, ts), { ok: false, why: "unsigned" });
  assert.deepEqual(verifyIngress(H({ ...good, "x-pl-sf-sig": signIngress("x".repeat(40), ts, body) }), body, KEY, ts), { ok: false, why: "bad_signature" });
  assert.deepEqual(verifyIngress(H({ ...good, "x-pl-sf-kid": "ev2" }), body, KEY, ts), { ok: false, why: "unknown_kid" });
  const old = ts - 301;
  assert.deepEqual(verifyIngress(H({ ...good, "x-pl-sf-ts": String(old), "x-pl-sf-sig": signIngress(KEY.key, old, body) }), body, KEY, ts), { ok: false, why: "expired" });
  const fut = ts + 301;
  assert.deepEqual(verifyIngress(H({ ...good, "x-pl-sf-ts": String(fut), "x-pl-sf-sig": signIngress(KEY.key, fut, body) }), body, KEY, ts), { ok: false, why: "expired" });
  assert.deepEqual(verifyIngress(H(good), body.replace("accA", "accB"), KEY, ts), { ok: false, why: "bad_signature" });
  assert.deepEqual(verifyIngress(H(good), body, null, ts), { ok: false, why: "not_configured" });
  const edge = ts - 300;
  assert.deepEqual(verifyIngress(H({ ...good, "x-pl-sf-ts": String(edge), "x-pl-sf-sig": signIngress(KEY.key, edge, body) }), body, KEY, ts), { ok: true });
});

// ── identity: only the ingress creates links ─────────────────────────────────
test("an intake form with someone's phone creates NO identity and sees no card; the signed link creates a NEW contact, never adopts the form's", async () => {
  const m = memStore();
  const formContact = m.intakeContact(ORG, "+17675550101", "attacker@example.invalid");
  assert.equal(m.ids.length, 0);
  assert.deepEqual(await loadPersonalLineCard({ orgId: ORG, contact: { id: formContact } }, m.cardDeps({})), { kind: "none" });

  const r = await linkPersonalLine(ORG, { plAccountId: "accA", waId: "17675550101", displayName: "Ann" }, m.store);  // POSITIVE TWIN
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.created && r.contactId !== formContact, "the link must not adopt the phone-matched form contact");
  assert.equal(m.ids.length, 1);
  assert.equal(m.contacts.get((r as any).contactId)?.phone, "+17675550101");
  assert.equal(m.contacts.get((r as any).contactId)?.email, null);
  // the form contact (whose email someone else controls) still has no line
  assert.deepEqual(await loadPersonalLineCard({ orgId: ORG, contact: { id: formContact } }, m.cardDeps({ accA: env("accA", "+1 767 818 5001", 41, "4.05") })), { kind: "none" });
});

test("the link is idempotent: a second signed link for the same account reuses its contact and refreshes the verified phone", async () => {
  const m = memStore();
  const a = await linkPersonalLine(ORG, { plAccountId: "accA", waId: "17675550101", displayName: null }, m.store);
  const b = await linkPersonalLine(ORG, { plAccountId: "accA", waId: "17675550199", displayName: null }, m.store);
  assert.ok(a.ok && b.ok && !b.created && a.contactId === b.contactId);
  assert.equal(m.ids.length, 1);
  assert.equal(m.contacts.get((a as any).contactId)?.phone, "+17675550199");
  assert.equal(m.contacts.get((a as any).contactId)?.firstName, "Personal Line subscriber");
});

test("STRUCTURE: the only code that writes external_identities is lib/personal-line/link.ts (forms, chat, intake cannot)", () => {
  const offenders: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(f)) {
    const s = readFileSync(f, "utf8");
    if (/(insert|update|delete)\(\s*externalIdentities\b/.test(s) || /\b(INSERT INTO|UPDATE|DELETE FROM)\s+external_identities\b/i.test(s)) offenders.push(path.relative(root, f).replace(/\\/g, "/"));
  } } };
  walk(path.join(root, "src"));
  assert.deepEqual(offenders, ["src/lib/personal-line/link.ts"]);       // POSITIVE CONTROL: the scan does find the real writer
});

// ── portal card: own line only ───────────────────────────────────────────────
test("contact A's portal session gets A's summary and never B's; B's gets B's (distinct subjects)", async () => {
  const m = memStore();
  const a = await linkPersonalLine(ORG, { plAccountId: "accA", waId: "17675550101", displayName: "Ann" }, m.store);
  const b = await linkPersonalLine(ORG, { plAccountId: "accB", waId: "17675550102", displayName: "Bob" }, m.store);
  const summaries = { accA: env("accA", "+1 767 818 5001", 41, "4.05"), accB: env("accB", "+1 767 818 5002", 52, "9.99") };
  const asked: string[] = [];
  const cardA = await loadPersonalLineCard({ orgId: ORG, contact: { id: (a as any).contactId } }, m.cardDeps(summaries, asked));
  assert.equal(cardA.kind, "ok");
  assert.equal(cardA.kind === "ok" && cardA.summary.did, "+1 767 818 5001");
  assert.equal(cardA.kind === "ok" && cardA.summary.minutesLeft, 41);
  assert.deepEqual(asked, ["accA"]);
  assert.doesNotMatch(JSON.stringify(cardA), /5002|9\.99|accB/);
  const cardB = await loadPersonalLineCard({ orgId: ORG, contact: { id: (b as any).contactId } }, m.cardDeps(summaries));
  assert.equal(cardB.kind === "ok" && cardB.summary.did, "+1 767 818 5002");
  // the same contact in ANOTHER workspace has no link there
  assert.deepEqual(await loadPersonalLineCard({ orgId: "22222222-2222-4222-8222-222222222222", contact: { id: (a as any).contactId } }, m.cardDeps(summaries)), { kind: "none" });
});

test("fail closed: a response for another account, a malformed figure, a refusal or an outage render the error card — never data", async () => {
  const m = memStore();
  const a = await linkPersonalLine(ORG, { plAccountId: "accA", waId: "17675550101", displayName: null }, m.store);
  const sess = { orgId: ORG, contact: { id: (a as any).contactId } };
  const wrong = env("accB", "+1 767 818 5002", 52, "9.99");
  assert.deepEqual(await loadPersonalLineCard(sess, m.cardDeps({ accA: wrong })), { kind: "error" });
  const neg = env("accA", "+1 767 818 5001", 41, "4.05"); (neg.data as any).minutes_left = -1;
  assert.deepEqual(await loadPersonalLineCard(sess, m.cardDeps({ accA: neg })), { kind: "error" });
  assert.deepEqual(await loadPersonalLineCard(sess, m.cardDeps({ accA: { status: "forbidden", code: "bad_signature", data: {} } })), { kind: "error" });
  assert.deepEqual(await loadPersonalLineCard(sess, { ...m.cardDeps({}), fetchSummary: async () => { throw new Error("down"); } }), { kind: "error" });
  assert.equal((await loadPersonalLineCard(sess, m.cardDeps({ accA: env("accA", "+1 767 818 5001", 41, "4.05") }))).kind, "ok"); // POSITIVE TWIN
  // unread facts stay null (never 0)
  const unread = env("accA", "+1 767 818 5001", 0, "0.00"); Object.assign(unread.data, { minutes_left: null, minutes_included: null, wallet: null, setup_state: "unknown" });
  const s = parseSummaryEnvelope(unread, "accA");
  assert.ok(s && s.minutesLeft === null && s.wallet === null && s.setupState === "unknown");
});

test("the signed summary fetch: exact headers, account inside the MAC, no-store, non-200 throws; unconfigured throws before any request", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(env("accA", "+1 767 818 5001", 41, "4.05")), { status: 200 }); }) as any;
  const f = makeSummaryFetcher({ baseUrl: "http://web:3005", key: { kid: "sf1", key: SKEY }, fetchImpl, nowS: () => 1_800_000_000 });
  await f("accA");
  assert.equal(calls[0].url, "http://web:3005/api/internal/pl-concierge/v1/account/summary?account=accA");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(calls[0].init.headers, { "x-pl-sf-kid": "sf1", "x-pl-sf-ts": "1800000000", "x-pl-sf-sig": "Srui8GmZxY_yMSVLAz8Gtz-tTHZnFCLmPiSnQMarZyM" });
  // CROSS-REPO VECTOR: the same literal is asserted by isolav2 test/pl-concierge-account-summary.test.ts
  assert.equal(signSummaryRequest(SKEY, 1_800_000_000, "accA"), "Srui8GmZxY_yMSVLAz8Gtz-tTHZnFCLmPiSnQMarZyM");
  const f500 = makeSummaryFetcher({ baseUrl: "http://web:3005", key: { kid: "sf1", key: SKEY }, fetchImpl: (async () => new Response("{}", { status: 401 })) as any });
  await assert.rejects(f500("accA"), /pl_summary_http_401/);
  let touched = 0;
  const unconf = makeSummaryFetcher({ baseUrl: undefined, key: { kid: "sf1", key: SKEY }, fetchImpl: (async () => { touched++; return new Response("{}"); }) as any });
  await assert.rejects(unconf("accA"), /not_configured/);
  assert.equal(touched, 0);
});

test("a contact with no identity link sees no card and causes no plsvc request", async () => {
  const m = memStore();
  const asked: string[] = [];
  const plain = m.intakeContact(ORG, "+17675550177", "x@example.invalid");
  assert.deepEqual(await loadPersonalLineCard({ orgId: ORG, contact: { id: plain } }, m.cardDeps({}, asked)), { kind: "none" });
  assert.deepEqual(asked, []);
});

// ── journey events (design §2) ───────────────────────────────────────────────
function eventStore() {
  const m = memStore();
  const inbox = new Map<string, { outcome: string | null }>();
  const facts = new Map<string, { v: number; f: Record<string, unknown> }>();
  const acts: any[] = [];
  const store: EventStore = {
    ...m.store,
    async claimEvent(_o, e) { if (inbox.has(e.eventId)) return false; inbox.set(e.eventId, { outcome: null }); return true; },
    async applyFactsIfNewer(o, acc, v, f) { const k = `${o}|${acc}`; const cur = facts.get(k); if (cur && cur.v >= v) return false; facts.set(k, { v, f: { ...(cur?.f ?? {}), ...f } }); return true; },
    async addActivity(o, c, a) { acts.push({ o, c, ...a }); return true; },
    async finishEvent(_o, id, _applied, outcome) { inbox.get(id)!.outcome = outcome; },
  };
  const emitted: any[] = [];
  const emit: Emit = async (type, data, orgId) => { emitted.push({ type, data, orgId }); };
  return { ...m, store, inbox, facts, acts, emitted, emit };
}
const ev = (over: Record<string, unknown> = {}) => JSON.stringify({
  event_id: "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d6e", type: "pl.line_created", occurred_at: "2026-10-11T12:00:00Z", version: 1,
  pl_account_id: "accA", wa_id: "17675550101", facts: { plan: "trial", trial_end: "2026-10-18T04:00:00Z" }, ...over,
});

test("events: strict parse — unknown type, missing proof fact, extra key, bad version refused; a valid event parses", () => {
  assert.ok(parsePlEvent(ev()));                                                                                   // POSITIVE
  assert.equal(parsePlEvent(ev({ type: "pl.signup_started" })), null, "intake is the native lead, not a PL event");
  assert.equal(parsePlEvent(ev({ type: "pl.app_activated", facts: { registration_now: "unknown" } })), null, "activation needs a live registration");
  assert.equal(parsePlEvent(ev({ type: "pl.app_activated", facts: { registration_now: "registered" } })), null, "activation needs activated_at");
  assert.ok(parsePlEvent(ev({ type: "pl.app_activated", facts: { registration_now: "registered", activated_at: "2026-10-11T12:01:00Z" } })));
  assert.equal(parsePlEvent(ev({ type: "pl.first_call", facts: {} })), null, "first_call needs the answered-CDR time");
  assert.equal(parsePlEvent(ev({ contact_id: "x" })), null);
  assert.equal(parsePlEvent(ev({ facts: { amount: 5 } })), null);
  assert.equal(parsePlEvent(ev({ version: 0 })), null);
  assert.equal(parsePlEvent(ev({ event_id: "not-a-uuid" })), null);
  assert.deepEqual([...PL_EVENT_TYPES].sort(), ["pl.app_activated", "pl.first_call", "pl.line_created", "pl.plan_purchased", "pl.registration_changed"]);
});

test("events: processed once onto the native timeline + bus; a replayed event_id is a no-op", async () => {
  const s = eventStore();
  const e = parsePlEvent(ev())!;
  const r1 = await processPlEvent(ORG, e, s.store, s.emit);
  assert.equal(r1.status, "processed");
  assert.equal(s.acts.length, 1); assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0].type, "pl.line_created"); assert.equal(s.emitted[0].orgId, ORG);
  assert.equal(s.emitted[0].data.contactId, (r1 as any).contactId);
  assert.equal(s.ids.length, 1, "the event attached the subscriber through the trusted link");
  const r2 = await processPlEvent(ORG, e, s.store, s.emit);
  assert.deepEqual(r2, { status: "duplicate" });
  assert.equal(s.acts.length, 1); assert.equal(s.emitted.length, 1);
});

test("events: an older version never overwrites newer facts; a stale registration_changed is not announced on the bus", async () => {
  const s = eventStore();
  const newer = parsePlEvent(ev({ event_id: "11111111-2222-4333-8444-555555555555", type: "pl.registration_changed", version: 5, facts: { registration_now: "registered" } }))!;
  const older = parsePlEvent(ev({ event_id: "66666666-7777-4888-8999-aaaaaaaaaaaa", type: "pl.registration_changed", version: 4, facts: { registration_now: "not_registered" } }))!;
  assert.equal(((await processPlEvent(ORG, newer, s.store, s.emit)) as any).factsApplied, true);
  const r = await processPlEvent(ORG, older, s.store, s.emit);
  assert.equal((r as any).factsApplied, false);
  assert.equal((r as any).emitted, false);
  assert.equal(s.facts.get(`${ORG}|accA`)!.f.registration_now, "registered");
  assert.equal(s.emitted.length, 1);
  assert.equal(s.acts.length, 2, "the older update is still on the timeline, marked as such");
  assert.match(s.acts[1].subject, /older update/);
  // a stale MILESTONE is still a fact that happened: announced once
  const firstCall = parsePlEvent(ev({ event_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", type: "pl.first_call", version: 3, facts: { first_call_at: "2026-10-11T13:00:00Z" } }))!;
  assert.equal(((await processPlEvent(ORG, firstCall, s.store, s.emit)) as any).emitted, true);
});

// ── the ONE signed webhook, per workspace (Law 20: the handler the route calls) ──
test("WEBHOOK: unconfigured workspace -> 503; unsigned / wrong key / old / other workspace's key -> 401; good -> 200 processed; replay -> duplicate", async () => {
  const s = eventStore();
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const keys: Record<string, { kid: string; key: string }> = { [ORG]: KEY, [OTHER]: { kid: "ev1", key: "other-workspace-key-0123456789abcdef-012" } };
  const deps = { resolveEventsKey: async (o: string) => keys[o] ?? null, store: async () => s.store, emit: s.emit };
  const body = ev();
  const ts = now();
  const req = (h: Record<string, string>, b = body) => new Request("http://localhost/api/webhooks/personal-line/x", { method: "POST", body: b, headers: h });
  const signed = (k = KEY.key, t = ts, b = body) => ({ "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(t), "x-pl-sf-sig": signIngress(k, t, b) });
  assert.equal((await handlePersonalLineWebhook(req(signed()), "33333333-3333-4333-8333-333333333333", deps)).status, 503);
  assert.equal((await handlePersonalLineWebhook(req(signed()), "not-a-uuid", deps)).status, 503);
  assert.equal((await handlePersonalLineWebhook(req({}), ORG, deps)).status, 401);
  assert.equal((await handlePersonalLineWebhook(req(signed("z".repeat(40))), ORG, deps)).status, 401);
  assert.equal((await handlePersonalLineWebhook(req(signed(KEY.key, ts - 400)), ORG, deps)).status, 401);
  // signed with the OTHER workspace's key, sent to ORG's path: refused (a key cannot reach another workspace)
  assert.equal((await handlePersonalLineWebhook(req(signed(keys[OTHER].key)), ORG, deps)).status, 401);
  assert.equal(s.emitted.length, 0, "nothing reached the bus before a valid signature");
  const bad = ev({ type: "pl.signup_started" });
  assert.equal((await handlePersonalLineWebhook(req(signed(KEY.key, ts, bad), bad), ORG, deps)).status, 422);
  const ok = await handlePersonalLineWebhook(req(signed()), ORG, deps);                                         // POSITIVE TWIN
  assert.equal(ok.status, 200); assert.equal(ok.body.status, "processed");
  assert.equal(s.emitted.length, 1); assert.equal(s.emitted[0].orgId, ORG);
  const again = await handlePersonalLineWebhook(req(signed()), ORG, deps);
  assert.deepEqual([again.status, again.body.status], [200, "duplicate"]);
  assert.equal(s.emitted.length, 1);
});

test("integration config: not connected / invalid -> null (no card, ingress 503); connected -> both keys from the workspace secret store", async () => {
  const rec = { connected: true, baseUrl: "http://web-acctsum:3005/", eventsKeyId: "ev1", summaryKeyId: "sf1" };
  const secrets: Record<string, string> = { [PL_SECRET_EVENTS]: KEY.key, [PL_SECRET_SUMMARY]: SKEY };
  const deps = (r: any, sec = secrets) => ({ readRecord: async () => r, readSecret: async (_o: string, n: string) => sec[n] ?? null });
  assert.deepEqual(await resolvePersonalLine(ORG, deps(rec)), { baseUrl: rec.baseUrl, events: { kid: "ev1", key: KEY.key }, summary: { kid: "sf1", key: SKEY } });
  assert.equal(await resolvePersonalLine(ORG, deps(null)), null);
  assert.equal(await resolvePersonalLine(ORG, deps({ ...rec, connected: false })), null);
  assert.equal(await resolvePersonalLine(ORG, deps({ ...rec, baseUrl: "ftp://x/" })), null);
  assert.equal((await resolvePersonalLine(ORG, deps(rec, { [PL_SECRET_EVENTS]: "short" })))?.events, null);
  assert.equal(validatePersonalLineSettings({ baseUrl: "https://u:p@x/", eventsKeyId: "ev1", summaryKeyId: "sf1" }), "invalid_base_url");
  assert.equal(validatePersonalLineSettings({ baseUrl: "https://x/", eventsKeyId: "EV 1", summaryKeyId: "sf1" }), "invalid_key_id");
});

test("CONFORMANCE: no Personal Line env var in the fork; keys come from workspace_secrets; one ingress route", () => {
  const files = ["src/lib/personal-line/signing.ts", "src/lib/personal-line/card.ts", "src/lib/personal-line/events.ts", "src/lib/personal-line/integration.ts", "src/app/api/webhooks/personal-line/[orgId]/route.ts"];
  for (const f of files) assert.doesNotMatch(read(f), /process\.env\.PL_|PL_SF_ORG_ID|PL_SUMMARY_BASE_URL/, f);
  assert.match(read("src/lib/personal-line/integration.ts"), /getSecretValue\(/);
  assert.match(read("src/lib/personal-line/actions.ts"), /storeSecret\(/);
  assert.match(read("src/app/(dashboard)/settings/integrations/page.tsx"), /testPersonalLineConnectionAction/);
  assert.throws(() => read("src/app/api/v1/integrations/personal-line/link/route.ts"));
  assert.throws(() => read("src/app/api/v1/integrations/personal-line/events/route.ts"));
});

test("events: the pl.* types are offered to native automations; no code emits pl.plan_purchased (no payment provider yet)", () => {
  const types = read("src/lib/events/event-types.ts");
  for (const t of PL_EVENT_TYPES) assert.match(types, new RegExp(`"${t.replace(".", "\\.")}"`));
  const mentions: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(f) && readFileSync(f, "utf8").includes("pl.plan_purchased")) mentions.push(path.relative(root, f).replace(/\\/g, "/")); } };
  walk(path.join(root, "src"));
  assert.deepEqual(mentions.sort(), ["src/lib/events/event-types.ts", "src/lib/personal-line/events.ts"]);   // definitions only, no emitter
  assert.match(read("drizzle/0081_integration_event_inbox.sql"), /CREATE TABLE IF NOT EXISTS integration_event_inbox/);
  assert.ok(JSON.parse(read("drizzle/meta/_journal.json")).entries.some((x: any) => x.tag === "0081_integration_event_inbox"));
});

// ── wiring + migration ───────────────────────────────────────────────────────
test("the portal Home renders the card from the SESSION only (no searchParams / params id reaches the loader)", () => {
  const page = read("src/app/customer/[orgSlug]/(client)/page.tsx");
  assert.match(page, /loadPersonalLineCard\(session, deps\)/);
  assert.match(page, /<PersonalLineCard card=\{personalLine\} \/>/);
  assert.doesNotMatch(page, /searchParams/);
  const card = read("src/components/customer-portal/personal-line-card.tsx");
  assert.match(card, /We can't show your line right now/);
});

test("migration 0080 is journaled, additive, idempotent, seeds nothing and declares both unique indexes", () => {
  const sql = read("drizzle/0080_external_identities.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS external_identities/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS external_identities_org_provider_external_uniq\s+ON external_identities\(org_id, provider, external_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS external_identities_org_provider_contact_uniq\s+ON external_identities\(org_id, provider, contact_id\)/);
  assert.doesNotMatch(sql, /INSERT INTO|DROP |ALTER TABLE contacts/i);
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  assert.ok(journal.entries.some((e: any) => e.tag === "0080_external_identities"));
});
