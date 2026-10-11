// EPIC 2026-10-11 - R1 slice S-c: the WhatsApp portal link. Every refusal has its positive twin in the same run (Law 19);
// the fakes key ONLY on the subject they are asked about, and the in-memory store is atomic where Postgres is
// (single-use consume), so a wrong subject or a double spend would be seen by these tests.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { signIngress, signPortalLinkRequest, verifyIngress, verifyPortalLinkRequest } from "../../src/lib/personal-line/signing";
import {
  handlePortalLinkRequest, hashLinkToken, parsePortalLinkRequest, redeemWaLink, waLinkInterstitial,
  WA_LINK_MARKER, WA_LINK_RATE_MAX, WA_LINK_TTL_MS, type PortalLinkStore, type RedeemStore,
} from "../../src/lib/personal-line/portal-link";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const KEY = { kid: "ev1", key: "events-unit-key-0123456789abcdef-01234" };
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const T0 = 1_800_000_000;
const RID = (n: number) => `0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d${String(n).padStart(2, "0")}`;

function world() {
  const links = [{ org: ORG, acc: "accA", contact: "cA" }, { org: ORG, acc: "accB", contact: "cB" }];
  const portalEnabled = new Set<string>();
  const rows: Array<{ org: string; contact: string; email: string; hash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date }> = [];
  const requests = new Map<string, string>();
  const slugs: Record<string, string> = { [ORG]: "pl-ws", [OTHER_ORG]: "other-ws" };
  const emails: Record<string, string | null> = { cA: null, cB: "b@example.invalid" };
  const state = { gate: true, nowMs: T0 * 1000 };
  const store: PortalLinkStore & RedeemStore = {
    async claimRequest(o, r) { const k = `${o}|${r}`; if (requests.has(k)) return false; requests.set(k, "claimed"); return true; },
    async finishRequest(o, r, outcome) { requests.set(`${o}|${r}`, outcome); },
    async findLinkedContact(o, acc) { return links.find((l) => l.org === o && l.acc === acc)?.contact ?? null; },
    async orgSlug(o) { return slugs[o] ?? null; },
    async portalAllowed() { return state.gate; },
    async recentMintCount(o, c, since) { return rows.filter((r) => r.org === o && r.contact === c && r.email === WA_LINK_MARKER && r.createdAt > since).length; },
    async mint(o, c, hash, expiresAt) {
      portalEnabled.add(`${o}|${c}`);
      for (const r of rows) if (r.org === o && r.contact === c && r.usedAt === null) r.usedAt = new Date(state.nowMs);
      rows.push({ org: o, contact: c, email: WA_LINK_MARKER, hash, expiresAt, usedAt: null, createdAt: new Date(state.nowMs) });
    },
    async orgIdForSlug(slug) { return Object.entries(slugs).find(([, s]) => s === slug)?.[0] ?? null; },
    async consume(o, hash, now) {
      const r = rows.find((x) => x.org === o && x.hash === hash && x.email === WA_LINK_MARKER && x.usedAt === null && x.expiresAt > now);
      if (!r) return null; r.usedAt = now; return { contactId: r.contact };      // synchronous check+set == the atomic UPDATE ... RETURNING
    },
    async isLinkedContact(o, c) { return links.some((l) => l.org === o && l.contact === c); },
    async contactEmail(_o, c) { return emails[c] ?? null; },
  };
  const seq: string[] = [];
  let n = 0;
  const deps = (over: Record<string, unknown> = {}) => ({
    resolveEventsKey: async (o: string) => (o === ORG || o === OTHER_ORG ? KEY : null),
    store: async () => store, appOrigin: () => "https://uplink.example.test", nowS: () => Math.floor(state.nowMs / 1000),
    newToken: () => { const t = `tok${++n}`.padEnd(43, "A"); seq.push(t); return t; }, ...over,
  });
  return { links, rows, portalEnabled, requests, store, state, deps, seq };
}
const body = (rid: string, acc: string, extra: Record<string, unknown> = {}) => JSON.stringify({ request_id: rid, pl_account_id: acc, ...extra });
const post = (org: string, d: any, raw: string, opts: { key?: string; ts?: number; kid?: string; signer?: (k: string, t: number, b: string) => string } = {}) => {
  const ts = opts.ts ?? T0;
  const sig = (opts.signer ?? signPortalLinkRequest)(opts.key ?? KEY.key, ts, raw);
  return handlePortalLinkRequest(new Request("http://x/api/webhooks/personal-line/o/portal-link", { method: "POST", body: raw, headers: { "x-pl-sf-kid": opts.kid ?? "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": sig } }), org, d);
};
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

test("signing: the portal-link MAC is domain-separated from the event-ingress MAC; cross-vector pinned", () => {
  const raw = body(RID(1), "accA");
  const h = (t: number, sig: string) => ({ get: (n: string) => ({ "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(t), "x-pl-sf-sig": sig } as Record<string, string>)[n.toLowerCase()] ?? null });
  assert.deepEqual(verifyPortalLinkRequest(h(T0, signPortalLinkRequest(KEY.key, T0, raw)), raw, KEY, T0), { ok: true });          // POSITIVE
  assert.deepEqual(verifyIngress(h(T0, signIngress(KEY.key, T0, raw)), raw, KEY, T0), { ok: true });                                // control: ingress unchanged
  assert.deepEqual(verifyPortalLinkRequest(h(T0, signIngress(KEY.key, T0, raw)), raw, KEY, T0), { ok: false, why: "bad_signature" }); // an event MAC is no portal-link MAC
  assert.deepEqual(verifyIngress(h(T0, signPortalLinkRequest(KEY.key, T0, raw)), raw, KEY, T0), { ok: false, why: "bad_signature" }); // ... and the reverse
  assert.equal(signPortalLinkRequest(KEY.key, 1_800_000_000, "{}"), signPortalLinkRequest(KEY.key, 1_800_000_000, "{}"));
  assert.notEqual(signPortalLinkRequest(KEY.key, 1_800_000_000, "{}"), signIngress(KEY.key, 1_800_000_000, "{}"));
  // CROSS-REPO VECTOR (event ingress): the same literal is asserted by isolav2 test/pl-sf-outbox.test.ts (#290), so the sender's
  // signIngress and this receiver's are pinned to each other from BOTH repos. (The summary read vector is pinned in the 2a spec.)
  assert.equal(
    signIngress("unit-events-key-0123456789abcdef-0123456789", 1_800_000_000,
      '{"event_id":"2d1f6b0e-6a0e-5f43-8f4d-0c5a8a3b9d11","type":"pl.line_created","occurred_at":"2026-10-11T12:00:00.000Z","version":1,"pl_account_id":"accA","wa_id":"17675550101","facts":{"did_masked":"+1 767 *** 5001"}}'),
    "rmvlNY1vxVwleKiduMiE93T7VWgtaI4O53DBuDQtM8g");
  // CROSS-REPO VECTOR: the literal below is asserted verbatim by isolav2 test/pl-concierge-portal-link.test.ts
  assert.equal(signPortalLinkRequest("portal-link-vector-key-0123456789abcdef", 1_800_000_000, '{"request_id":"0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d01","pl_account_id":"accA"}'), VECTOR);
});
const VECTOR = "BddSF9Da7uXkNRLoZ-uuZtvWtJavVcusObqDBWuWzdY";

test("mint: a linked account gets a URL; portal access is enabled for THAT contact only; only the hash is stored", async () => {
  const w = world();
  const r = await post(ORG, w.deps(), body(RID(1), "accA"));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const url = new URL(r.body.url as string);
  assert.equal(url.origin + url.pathname, "https://uplink.example.test/customer/pl-ws/wa-link");
  const tok = tokenOf(r.body.url as string);
  assert.equal(r.body.expires_at, new Date(T0 * 1000 + WA_LINK_TTL_MS).toISOString());
  assert.deepEqual([...w.portalEnabled], [`${ORG}|cA`], "B was not enabled");
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].hash, hashLinkToken(tok));
  assert.ok(!JSON.stringify(w.rows).includes(tok), "the token itself is never stored");
  assert.equal(w.rows[0].contact, "cA");
});

test("refusals, each with the positive twin above: unknown workspace 503, unsigned/wrong key/kid/old/future 401, event-MAC 401, bad body 422", async () => {
  const w = world();
  const ok = body(RID(2), "accA");
  assert.equal((await post("33333333-3333-4333-8333-333333333333", w.deps(), ok)).status, 503);
  assert.equal((await post("not-a-uuid", w.deps(), ok)).status, 503);
  assert.equal((await post(ORG, w.deps(), ok, { key: "z".repeat(40) })).status, 401);
  assert.equal((await post(ORG, w.deps(), ok, { kid: "ev2" })).status, 401);
  assert.equal((await post(ORG, w.deps(), ok, { ts: T0 - 301 })).status, 401);
  assert.equal((await post(ORG, w.deps(), ok, { ts: T0 + 301 })).status, 401);
  assert.equal((await post(ORG, w.deps(), ok, { signer: signIngress })).status, 401, "a valid EVENT signature does not open the portal-link door");
  const unsigned = await handlePortalLinkRequest(new Request("http://x", { method: "POST", body: ok }), ORG, w.deps());
  assert.equal(unsigned.status, 401);
  assert.equal(w.rows.length, 0, "nothing minted by any refused request");
  assert.equal(w.requests.size, 0, "a refused request does not even consume a request id");
  assert.equal((await post(ORG, w.deps(), "not json")).status, 422);
  assert.equal((await post(ORG, w.deps(), body(RID(2), "accA", { wa_id: "17675550101" }))).status, 422, "extra key (a typed phone) is refused");
  assert.equal((await post(ORG, w.deps(), body("not-a-uuid", "accA"))).status, 422);
  assert.equal((await post(ORG, w.deps(), body(RID(2), "acc A!"))).status, 422);
  assert.equal(w.rows.length, 0);
  assert.equal((await post(ORG, w.deps(), ok)).status, 200);                                                                      // POSITIVE TWIN
  assert.equal(w.rows.length, 1);
});

test("wrong workspace: the other workspace's path with this workspace's key semantics cannot mint for ORG's account; and ORG's account is not linked in OTHER", async () => {
  const w = world();
  const d = w.deps({ resolveEventsKey: async (o: string) => (o === ORG ? KEY : o === OTHER_ORG ? { kid: "ev1", key: "other-workspace-key-0123456789abcdef-012" } : null) });
  assert.equal((await post(OTHER_ORG, d, body(RID(3), "accA"))).status, 401, "signed with ORG's key, sent to OTHER's path");
  assert.equal((await post(OTHER_ORG, d, body(RID(4), "accA"), { key: "other-workspace-key-0123456789abcdef-012" })).status, 404, "OTHER's own key still finds no accA link in OTHER");
  assert.equal(w.rows.length, 0);
  assert.equal((await post(ORG, d, body(RID(5), "accA"))).status, 200);                                                          // POSITIVE TWIN
});

test("unlinked / unknown account -> 404, nothing minted, nothing enabled (twin: linked account 200)", async () => {
  const w = world();
  const r = await post(ORG, w.deps(), body(RID(6), "accZZZ"));
  assert.deepEqual([r.status, r.body.error], [404, "account_not_linked"]);
  assert.equal(w.rows.length, 0); assert.equal(w.portalEnabled.size, 0);
  assert.equal((await post(ORG, w.deps(), body(RID(7), "accB"))).status, 200);                                                    // POSITIVE TWIN
  assert.deepEqual([...w.portalEnabled], [`${ORG}|cB`]);
});

test("replay: the same request_id never mints twice (409); a fresh request_id does (twin)", async () => {
  const w = world();
  const raw = body(RID(8), "accA");
  assert.equal((await post(ORG, w.deps(), raw)).status, 200);
  const again = await post(ORG, w.deps(), raw);
  assert.deepEqual([again.status, again.body.error], [409, "replayed_request"]);
  assert.equal(w.rows.length, 1, "the replay minted nothing");
  assert.equal((await post(ORG, w.deps(), body(RID(9), "accA"))).status, 200);
});

test("plan gate and per-contact rate limit refuse without minting; the newest link supersedes the older", async () => {
  const w = world();
  w.state.gate = false;
  const g = await post(ORG, w.deps(), body(RID(10), "accA"));
  assert.deepEqual([g.status, g.body.error], [409, "portal_unavailable"]);
  assert.equal(w.rows.length, 0); assert.equal(w.portalEnabled.size, 0);
  w.state.gate = true;
  const urls: string[] = [];
  for (let i = 0; i < WA_LINK_RATE_MAX; i++) { const r = await post(ORG, w.deps(), body(RID(20 + i), "accA")); assert.equal(r.status, 200); urls.push(r.body.url as string); }
  const limited = await post(ORG, w.deps(), body(RID(30), "accA"));
  assert.deepEqual([limited.status, limited.body.error], [429, "rate_limited"]);
  assert.equal(w.rows.length, WA_LINK_RATE_MAX);
  assert.equal((await post(ORG, w.deps(), body(RID(31), "accB"))).status, 200, "B has her own budget (the limit is per contact)");
  const store = w.store;
  assert.equal(await redeemWaLink("pl-ws", tokenOf(urls[0]), store, new Date(T0 * 1000 + 1000)), null, "an older link was superseded");
  assert.ok(await redeemWaLink("pl-ws", tokenOf(urls[WA_LINK_RATE_MAX - 1]), store, new Date(T0 * 1000 + 1000)), "the newest link works");
});

test("redeem: single use, expiry, wrong token, wrong workspace, cross-contact (A's link never opens B), identity removed", async () => {
  const w = world();
  const a = tokenOf((await post(ORG, w.deps(), body(RID(40), "accA"))).body.url as string);
  const b = tokenOf((await post(ORG, w.deps(), body(RID(41), "accB"))).body.url as string);
  const inWindow = new Date(T0 * 1000 + 60_000);
  // cross-contact: A's token yields A's contact only; B's yields B's; neither can yield the other
  const gotA = await redeemWaLink("pl-ws", a, w.store, inWindow);
  assert.deepEqual(gotA, { orgId: ORG, contactId: "cA", email: WA_LINK_MARKER });     // email-less subscriber gets the fixed marker
  const gotB = await redeemWaLink("pl-ws", b, w.store, inWindow);
  assert.deepEqual(gotB, { orgId: ORG, contactId: "cB", email: "b@example.invalid" });
  assert.notEqual(gotA!.contactId, gotB!.contactId);
  // single use: both are spent now
  assert.equal(await redeemWaLink("pl-ws", a, w.store, inWindow), null);
  assert.equal(await redeemWaLink("pl-ws", b, w.store, inWindow), null);
  // expiry (twin: the same flow inside the window worked above)
  const c = tokenOf((await post(ORG, w.deps(), body(RID(42), "accA"))).body.url as string);
  assert.equal(await redeemWaLink("pl-ws", c, w.store, new Date(T0 * 1000 + WA_LINK_TTL_MS + 1)), null);
  // an expired token stays unusable even inside a later window; still-unspent rows are only consumable in-window
  const d = tokenOf((await post(ORG, w.deps(), body(RID(43), "accB"))).body.url as string);
  assert.equal(await redeemWaLink("other-ws", d, w.store, inWindow), null, "wrong workspace");
  assert.equal(await redeemWaLink("pl-ws", d.slice(0, 42) + (d.endsWith("A") ? "B" : "A"), w.store, inWindow), null, "tampered token");
  assert.equal(await redeemWaLink("pl-ws", "short", w.store, inWindow), null);
  assert.ok(await redeemWaLink("pl-ws", d, w.store, inWindow), "the untouched token still works (positive twin for the three refusals)");
  // identity removed after minting -> the link is dead
  const e = tokenOf((await post(ORG, w.deps(), body(RID(44), "accA"))).body.url as string);
  w.links.splice(w.links.findIndex((l) => l.acc === "accA"), 1);
  assert.equal(await redeemWaLink("pl-ws", e, w.store, inWindow), null);
});

test("redeem: two concurrent redemptions of one link -> exactly one wins", async () => {
  const w = world();
  const t = tokenOf((await post(ORG, w.deps(), body(RID(50), "accA"))).body.url as string);
  const now = new Date(T0 * 1000 + 1000);
  const results = await Promise.all([redeemWaLink("pl-ws", t, w.store, now), redeemWaLink("pl-ws", t, w.store, now), redeemWaLink("pl-ws", t, w.store, now)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("parse + interstitial: strict body; the interstitial escapes the token and posts to the same workspace path", () => {
  assert.deepEqual(parsePortalLinkRequest(body(RID(60), "accA")), { requestId: RID(60), plAccountId: "accA" });
  assert.equal(parsePortalLinkRequest(body(RID(60), "accA", { phone: "1" })), null);
  assert.equal(parsePortalLinkRequest("[]"), null);
  const html = waLinkInterstitial("pl-ws", "abc\"><script>x</script>");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /method="post" action="\/customer\/pl-ws\/wa-link"/);
  assert.match(html, /noindex/);
});

test("WIRING: the portal-link route uses the handler + events key; the redemption GET never consumes; POST sets the portal cookie", () => {
  const r = read("src/app/api/webhooks/personal-line/[orgId]/portal-link/route.ts");
  assert.match(r, /handlePortalLinkRequest\(/); assert.match(r, /resolvePersonalLine\(/);
  const wa = read("src/app/customer/[orgSlug]/wa-link/route.ts");
  const get = wa.slice(wa.indexOf("export async function GET"), wa.indexOf("export async function POST"));
  const postFn = wa.slice(wa.indexOf("export async function POST"));
  assert.doesNotMatch(get, /redeemWaLink|drizzlePortalLinkStore|consume/);      // a preview / prefetch cannot spend the link
  assert.match(postFn, /redeemWaLink\(/); assert.match(postFn, /PORTAL_SESSION_COOKIE/); assert.match(postFn, /signPortalSession\(/);
  const lib = read("src/lib/personal-line/portal-link.ts");
  assert.doesNotMatch(lib.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"), /process\.env\.PL_/);
  // the minted URL is a JSON field returned to the signed caller; the redemption route never echoes a token back
  assert.doesNotMatch(wa.slice(wa.indexOf("export async function POST")), /searchParams|token:/);
});
