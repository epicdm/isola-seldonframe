// Chatwoot customer link: "Open in Chatwoot" on /contacts/[id], from a PERSON-CONFIRMED mapping only.
//
// Path under test (the same functions the page and both Server Actions call): session actor -> service core -> store (in-memory here,
// real Postgres in tests/integration/chatwoot-link-db.spec.ts) -> READ-ONLY Chatwoot reader over real HTTP to a local fake Chatwoot ->
// signed activity record -> dashboard URL -> rendered view.
// Fixture provenance: response shapes follow Chatwoot v4.18 as read from the running uplink_chat image source on 2026-10-21
// (contacts#search payload, contacts/:id/conversations payload, conversation "id" = display_id) and the v4 application swagger. All ids,
// names, phones and emails are fictional (555 numbers, example.test). Every absence assertion has a positive control in this file.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { renderToString } from "react-dom/server";

import { ChatwootLinkView } from "@/components/contacts/chatwoot-link-view";
import {
  chatwootAccountForOrg,
  chatwootConversationUrl,
  loadChatwootLinkTarget,
  loadChatwootLookupConfig,
} from "@/lib/chatwoot-link/config";
import { makeChatwootReader } from "@/lib/chatwoot-link/reader";
import { CHATWOOT_LINK_ACTIVITY_TYPE, chatwootLinkKey, chatwootLinkMetadata, verifyChatwootLink } from "@/lib/chatwoot-link/record";
import {
  confirmChatwootLink,
  findChatwootCandidates,
  getChatwootLinkState,
  phoneKey,
  type Actor,
  type ChatwootLinkDeps,
  type ChatwootLinkStore,
  type LinkActivityRow,
  type LinkContact,
} from "@/lib/chatwoot-link/service";
import { makeChatwootLinkDeps } from "@/lib/chatwoot-link/wiring";

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1"; // the workspace mapped to Chatwoot account 2
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b2"; // another workspace, NOT mapped
const CONTACT_A = "aaaaaaaa-1111-4000-8000-0000000000c1"; // in ORG_A, phone + email match Chatwoot contact 501
const CONTACT_A2 = "aaaaaaaa-1111-4000-8000-0000000000c2"; // in ORG_A, no match anywhere
const CONTACT_B = "bbbbbbbb-1111-4000-8000-0000000000c3"; // in ORG_B, same phone as CONTACT_A
const USER_ADMIN = "aaaaaaaa-2222-4000-8000-0000000000d1";
const TOKEN = "cw-test-token-fictional-0123456789";
const AUTH_SECRET = "test-auth-secret-fictional-0123456789";

// ── fake Chatwoot (account 2) ────────────────────────────────────────────────────────────────────────────────────────────────────────
type Req = { method: string; path: string; token: string | undefined };
let server: Server;
let cwBase = "";
let requests: Req[] = [];
let failAll = false;

const CW_CONTACTS = [
  { id: 501, name: "Test Customer", phone_number: "+15550100123", email: "customer@example.test" },
  { id: 502, name: "Other Person", phone_number: "+15550100123999", email: null }, // contains the digits: an ILIKE hit, NOT an exact match
  { id: 503, name: "Test Customer", phone_number: "+15550100999", email: "someone-else@example.test" }, // same NAME only: never a candidate
];
const CW_CONVERSATIONS: Record<number, unknown[]> = {
  501: [
    { id: 41, account_id: 2, inbox_id: 11, status: "open", last_activity_at: 1_760_000_000 },
    { id: 17, account_id: 2, inbox_id: 7, status: "resolved", last_activity_at: 1_750_000_000 },
    { id: 99, account_id: 4, inbox_id: 1, status: "open", last_activity_at: 1_770_000_000 }, // claims another account: filtered
  ],
  502: [{ id: 77, account_id: 2, inbox_id: 11, status: "open", last_activity_at: 1_760_000_100 }],
  503: [{ id: 88, account_id: 2, inbox_id: 11, status: "open", last_activity_at: 1_760_000_200 }],
};

function handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  requests.push({ method: req.method ?? "", path: url.pathname + url.search, token: req.headers["api_access_token"] as string | undefined });
  const send = (s: number, b: unknown) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(b));
  };
  if (failAll) return send(500, { error: "down" });
  if (req.headers["api_access_token"] !== TOKEN) return send(401, { error: "unauthorized" });
  if (req.method !== "GET") return send(405, { error: "read-only fake" });
  if (url.pathname === "/api/v1/accounts/2/contacts/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const hit = CW_CONTACTS.filter((c) => [c.name, c.phone_number, c.email].some((v) => (v ?? "").toLowerCase().includes(q)));
    return send(200, { meta: { count: hit.length, current_page: 1 }, payload: hit });
  }
  const m = /^\/api\/v1\/accounts\/2\/contacts\/(\d+)\/conversations$/.exec(url.pathname);
  if (m) return send(200, { payload: CW_CONVERSATIONS[Number(m[1])] ?? [] });
  return send(404, { error: "not found" });
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cwBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
  failAll = false;
});

// ── in-memory store with the SAME scoping contract as the SQL store (proven against Postgres in the integration spec) ─────────────────
function memStore() {
  const contacts: LinkContact[] = [
    { id: CONTACT_A, orgId: ORG_A, firstName: "Test", lastName: "Customer", email: "Customer@Example.test", phone: "(555) 010-0123" },
    { id: CONTACT_A2, orgId: ORG_A, firstName: "No", lastName: "Match", email: null, phone: "555 010 0456" },
    { id: CONTACT_B, orgId: ORG_B, firstName: "Same", lastName: "Phone", email: null, phone: "+1 555 010 0123" },
  ];
  const acts: Array<LinkActivityRow & { type: string; userId: string; subject: string }> = [];
  const store: ChatwootLinkStore = {
    async getContact(orgId, id) {
      return contacts.find((c) => c.orgId === orgId && c.id === id) ?? null;
    },
    async linkActivities(orgId, contactId, limit) {
      return acts.filter((a) => a.orgId === orgId && a.contactId === contactId && a.type === CHATWOOT_LINK_ACTIVITY_TYPE).reverse().slice(0, limit);
    },
    async insertLinkActivity(a) {
      acts.push({ orgId: a.orgId, contactId: a.contactId, metadata: a.metadata, type: CHATWOOT_LINK_ACTIVITY_TYPE, userId: a.userId, subject: a.subject });
    },
  };
  return { store, acts };
}

const ENV = {
  CHATWOOT_LINK_ACCOUNTS: `${ORG_A}:2`,
  CHATWOOT_LINK_PUBLIC_URL: "https://chat.example.test",
  CHATWOOT_LINK_API_TOKEN_FILE: "/run/secrets/fictional_chatwoot_link_token",
  AUTH_SECRET,
};

function depsFor(orgId: string, store: ChatwootLinkStore, env: Record<string, string | undefined> = ENV): ChatwootLinkDeps {
  const e = { ...env, CHATWOOT_LINK_API_URL: cwBase };
  const target = loadChatwootLinkTarget(orgId, e);
  const lookup = target ? loadChatwootLookupConfig(orgId, e, () => TOKEN) : null;
  return {
    store,
    target,
    lookup,
    reader: lookup ? makeChatwootReader({ apiBase: lookup.apiBase, accountId: lookup.accountId, apiToken: lookup.apiToken }) : null,
    key: chatwootLinkKey(e),
    now: () => new Date("2026-10-21T12:00:00.000Z"),
  };
}

const admin = (orgId = ORG_A): Actor => ({ orgId, userId: USER_ADMIN, role: "admin", realPerson: true });

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("config: only a mapped workspace gets anything", () => {
  test("mapped workspace -> account 2; unmapped workspace -> null (control: the same env maps ORG_A)", () => {
    assert.equal(chatwootAccountForOrg(ORG_A, ENV.CHATWOOT_LINK_ACCOUNTS), "2");
    assert.equal(chatwootAccountForOrg(ORG_B, ENV.CHATWOOT_LINK_ACCOUNTS), null);
    assert.deepEqual(loadChatwootLinkTarget(ORG_A, ENV), { publicBase: "https://chat.example.test", accountId: "2" });
    assert.equal(loadChatwootLinkTarget(ORG_B, ENV), null);
  });
  test("ambiguous (same workspace, two accounts) and malformed mappings -> null", () => {
    assert.equal(chatwootAccountForOrg(ORG_A, `${ORG_A}:2,${ORG_A}:4`), null);
    assert.equal(chatwootAccountForOrg(ORG_A, `${ORG_A}:2,${ORG_A}:2`), "2"); // control: a duplicate of the SAME pair is not ambiguous
    assert.equal(chatwootAccountForOrg(ORG_A, `${ORG_A}:abc`), null);
    assert.equal(chatwootAccountForOrg(ORG_A, `${ORG_A}:2:9`), null);
    assert.equal(chatwootAccountForOrg("not-a-uuid", "not-a-uuid:2"), null);
  });
  test("public URL must be https without credentials/query (control: the plain https origin is accepted)", () => {
    assert.equal(loadChatwootLinkTarget(ORG_A, { ...ENV, CHATWOOT_LINK_PUBLIC_URL: "http://chat.example.test" }), null);
    assert.equal(loadChatwootLinkTarget(ORG_A, { ...ENV, CHATWOOT_LINK_PUBLIC_URL: "https://u:p@chat.example.test" }), null);
    assert.equal(loadChatwootLinkTarget(ORG_A, { ...ENV, CHATWOOT_LINK_PUBLIC_URL: "https://chat.example.test/?t=1" }), null);
    assert.notEqual(loadChatwootLinkTarget(ORG_A, { ...ENV, CHATWOOT_LINK_PUBLIC_URL: "https://chat.example.test/" }), null);
  });
  test("lookup needs a readable, non-empty token file; the target alone does not (control: with a token, lookup is configured)", () => {
    assert.equal(loadChatwootLookupConfig(ORG_A, { ...ENV, CHATWOOT_LINK_API_TOKEN_FILE: "" }, () => TOKEN), null);
    assert.equal(loadChatwootLookupConfig(ORG_A, ENV, () => "   "), null);
    assert.equal(loadChatwootLookupConfig(ORG_A, ENV, () => { throw new Error("ENOENT"); }), null);
    const ok = loadChatwootLookupConfig(ORG_A, ENV, () => `${TOKEN}\n`);
    assert.equal(ok?.apiToken, TOKEN);
    assert.equal(ok?.apiBase, "https://chat.example.test"); // default API base = public URL
  });
  test("an unmapped workspace never reads the token file (control: the mapped one does)", () => {
    let reads = 0;
    const rf = () => { reads++; return TOKEN; };
    assert.equal(loadChatwootLookupConfig(ORG_B, ENV, rf), null);
    assert.equal(reads, 0);
    loadChatwootLookupConfig(ORG_A, ENV, rf);
    assert.equal(reads, 1);
  });
  test("conversation URL = <public>/app/accounts/<account>/conversations/<display id>; never carries the token", () => {
    const url = chatwootConversationUrl({ publicBase: "https://chat.example.test", accountId: "2" }, 41);
    assert.equal(url, "https://chat.example.test/app/accounts/2/conversations/41");
    assert.ok(!url.includes(TOKEN) && !url.includes("token") && !url.includes("?"));
    assert.throws(() => chatwootConversationUrl({ publicBase: "https://chat.example.test", accountId: "2" }, 0));
  });
  test("wiring: makeChatwootLinkDeps builds target/lookup/reader/key for the mapped workspace only (control: same env)", () => {
    let reads = 0;
    const rf = () => { reads++; return TOKEN; };
    const a = makeChatwootLinkDeps(ORG_A, { env: ENV, readSecretFile: rf });
    assert.ok(a.target && a.lookup && a.reader && a.key);
    const b = makeChatwootLinkDeps(ORG_B, { env: ENV, readSecretFile: rf });
    assert.equal(b.target, null);
    assert.equal(b.lookup, null);
    assert.equal(b.reader, null);
    assert.equal(reads, 1);
    assert.equal(makeChatwootLinkDeps(ORG_A, { env: { ...ENV, AUTH_SECRET: "" }, readSecretFile: rf }).key, null); // no key = no links
  });
});

// ── the signed record ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("record: only a signed, person-confirmed row for THIS contact counts", () => {
  const key = chatwootLinkKey({ AUTH_SECRET })!;
  const rec = { orgId: ORG_A, uplinkContactId: CONTACT_A, accountId: "2", chatwootContactId: 501, conversationId: 41, confirmedByUserId: USER_ADMIN, confirmedAt: "2026-10-21T12:00:00.000Z" };
  const meta = chatwootLinkMetadata(rec, key);
  const exp = { orgId: ORG_A, contactId: CONTACT_A, accountId: "2" };
  test("control: a genuine row verifies", () => {
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: meta }, exp, key)?.conversationId, 41);
  });
  test("the same metadata on another contact or in another workspace does not verify", () => {
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A2, metadata: meta }, { ...exp, contactId: CONTACT_A2 }, key), null);
    assert.equal(verifyChatwootLink({ orgId: ORG_B, contactId: CONTACT_A, metadata: meta }, { ...exp, orgId: ORG_B }, key), null);
  });
  test("a tampered conversation, a hand-written row (no sig), another key, or a re-mapped account does not verify", () => {
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: { ...meta, conversationId: 42 } }, exp, key), null);
    const { sig: _sig, ...unsigned } = meta;
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: unsigned }, exp, key), null);
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: meta }, exp, chatwootLinkKey({ AUTH_SECRET: "another-secret-fictional-000000" })), null);
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: meta }, { ...exp, accountId: "4" }, key), null);
    assert.equal(verifyChatwootLink({ orgId: ORG_A, contactId: CONTACT_A, metadata: meta }, exp, null), null);
  });
  test("no AUTH_SECRET -> no key (there is no fallback key)", () => {
    assert.equal(chatwootLinkKey({}), null);
    assert.equal(chatwootLinkKey({ AUTH_SECRET: "short" }), null);
  });
});

// ── the path ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("path: candidates are suggestions; only a confirmed record becomes a link", () => {
  test("phone normalisation: formatting and a NANP leading 1 do not matter; too-short numbers are ignored", () => {
    assert.equal(phoneKey("(555) 010-0123"), "5550100123");
    assert.equal(phoneKey("+1 555 010 0123"), "5550100123");
    assert.equal(phoneKey("123"), null);
  });

  test("candidates: exact phone/email only, the account-4 conversation filtered, name-only and digit-substring hits excluded", async () => {
    const { store } = memStore();
    const r = await findChatwootCandidates(admin(), CONTACT_A, depsFor(ORG_A, store));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.candidates.map((c) => [c.chatwootContactId, c.conversationId]), [[501, 41], [501, 17]]);
    assert.deepEqual(r.candidates[0].matchedOn, ["phone", "email"]);
    assert.ok(!r.candidates.some((c) => c.chatwootContactId === 502), "a number that merely CONTAINS the digits is not a match");
    assert.ok(!r.candidates.some((c) => c.chatwootContactId === 503), "the same name is not a match");
    assert.ok(!r.candidates.some((c) => c.conversationId === 99), "a conversation claiming another account is not offered");
    assert.ok(requests.length > 0 && requests.every((q) => q.method === "GET" && q.token === TOKEN), "read-only GETs with the server-side token");
    assert.ok(!requests.some((q) => q.path.includes("Test%20Customer") || q.path.toLowerCase().includes("q=test")), "never searched by name");
  });

  test("finding candidates does not link: the state stays unlinked and nothing is written", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    await findChatwootCandidates(admin(), CONTACT_A, d);
    assert.deepEqual(await getChatwootLinkState(ORG_A, CONTACT_A, d), { state: "unlinked" });
    assert.equal(acts.length, 0);
  });

  test("no candidates: an unmatched contact gets an empty list (control: CONTACT_A in the same harness gets two)", async () => {
    const { store } = memStore();
    const r = await findChatwootCandidates(admin(), CONTACT_A2, depsFor(ORG_A, store));
    assert.deepEqual(r, { ok: true, candidates: [] });
  });

  test("confirm by an owner/admin -> link to the Chatwoot conversation; the page state then shows the same link", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    const r = await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 }, d);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.link.url, "https://chat.example.test/app/accounts/2/conversations/41");
    assert.equal(acts.length, 1);
    assert.equal(acts[0].userId, USER_ADMIN);
    assert.equal(acts[0].subject, "Linked to Chatwoot conversation #41");
    assert.ok(!JSON.stringify(acts[0].metadata).includes(TOKEN), "the token is never stored");
    const s = await getChatwootLinkState(ORG_A, CONTACT_A, d);
    assert.deepEqual(s, { state: "linked", url: r.link.url, conversationId: 41, confirmedAt: "2026-10-21T12:00:00.000Z" });
    assert.ok(requests.every((q) => q.method === "GET"), "Chatwoot was only read");
  });

  test("a member, or an admin-token / operator-portal session, cannot confirm (control: the admin above can)", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    const input = { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 };
    assert.deepEqual(await confirmChatwootLink({ ...admin(), role: "member" }, input, d), { ok: false, code: "forbidden" });
    assert.deepEqual(await confirmChatwootLink({ ...admin(), realPerson: false }, input, d), { ok: false, code: "forbidden" });
    assert.equal(acts.length, 0);
  });

  test("a crafted pair that is not a current candidate is refused (other contact's conversation, unknown id, account-4 id)", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    for (const [cw, conv] of [[502, 77], [503, 88], [501, 99], [501, 12345]] as const) {
      assert.deepEqual(await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: cw, conversationId: conv }, d), { ok: false, code: "not_a_candidate" });
    }
    assert.deepEqual(await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: "501", conversationId: 41 }, d), { ok: false, code: "invalid" });
    assert.equal(acts.length, 0);
  });

  test("TENANT: a contact from another workspace can never be looked up, linked or shown; no Chatwoot call is made", async () => {
    const { store, acts } = memStore();
    // ORG_B is not mapped at all: nothing shown, nothing called.
    const dB = depsFor(ORG_B, store);
    assert.deepEqual(await getChatwootLinkState(ORG_B, CONTACT_B, dB), { state: "unavailable" });
    assert.deepEqual(await findChatwootCandidates(admin(ORG_B), CONTACT_B, dB), { ok: false, code: "unavailable" });
    // ORG_A's session aimed at ORG_B's contact (same phone as CONTACT_A!): not found, before any Chatwoot call.
    const dA = depsFor(ORG_A, store);
    assert.deepEqual(await findChatwootCandidates(admin(ORG_A), CONTACT_B, dA), { ok: false, code: "not_found" });
    assert.deepEqual(await confirmChatwootLink(admin(ORG_A), { contactId: CONTACT_B, chatwootContactId: 501, conversationId: 41 }, dA), { ok: false, code: "not_found" });
    assert.deepEqual(await getChatwootLinkState(ORG_A, CONTACT_B, dA), { state: "unavailable" });
    // ORG_B's session aimed at ORG_A's contact, even with ORG_A's deps: not found.
    assert.deepEqual(await findChatwootCandidates(admin(ORG_B), CONTACT_A, dA), { ok: false, code: "not_found" });
    assert.deepEqual(await confirmChatwootLink(admin(ORG_B), { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 }, dA), { ok: false, code: "not_found" });
    assert.equal(requests.length, 0, "no Chatwoot request for any cross-workspace attempt");
    assert.equal(acts.length, 0);
    // control: the legitimate pairing in the same harness does reach Chatwoot and does find candidates.
    const ok = await findChatwootCandidates(admin(ORG_A), CONTACT_A, dA);
    assert.ok(ok.ok && ok.candidates.length === 2);
    assert.ok(requests.length > 0);
  });

  test("a link confirmed for ORG_A's contact is not shown on any other contact (control: it is shown on its own)", async () => {
    const { store } = memStore();
    const d = depsFor(ORG_A, store);
    await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 }, d);
    assert.equal((await getChatwootLinkState(ORG_A, CONTACT_A, d)).state, "linked");
    assert.equal((await getChatwootLinkState(ORG_A, CONTACT_A2, d)).state, "unlinked");
  });

  test("a forged activity (any writer can choose the type) is not a link (control: a genuine confirm on the same store is)", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    await store.insertLinkActivity({ orgId: ORG_A, contactId: CONTACT_A, userId: USER_ADMIN, subject: "x", metadata: { schema: "chatwoot-link/v1", accountId: "2", chatwootContactId: 501, conversationId: 41, confirmedByUserId: USER_ADMIN, confirmedAt: "2026-10-21T00:00:00.000Z", sig: "0".repeat(64) } });
    assert.equal(acts.length, 1);
    assert.deepEqual(await getChatwootLinkState(ORG_A, CONTACT_A, d), { state: "unlinked" });
    await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 17 }, d);
    assert.equal((await getChatwootLinkState(ORG_A, CONTACT_A, d)).state, "linked");
  });

  test("Chatwoot down: lookup and confirm say so and write nothing (never 'no conversation', never a link)", async () => {
    const { store, acts } = memStore();
    const d = depsFor(ORG_A, store);
    failAll = true;
    assert.deepEqual(await findChatwootCandidates(admin(), CONTACT_A, d), { ok: false, code: "chatwoot_unreachable" });
    assert.deepEqual(await confirmChatwootLink(admin(), { contactId: CONTACT_A, chatwootContactId: 501, conversationId: 41 }, d), { ok: false, code: "chatwoot_unreachable" });
    assert.equal(acts.length, 0);
    assert.ok(requests.length > 0, "control: Chatwoot WAS asked");
  });

  test("a wrong token is refused by Chatwoot and reported as unreachable, not as 'no matches'", async () => {
    const { store } = memStore();
    const d = depsFor(ORG_A, store);
    d.reader = makeChatwootReader({ apiBase: cwBase, accountId: "2", apiToken: "wrong-token" });
    assert.deepEqual(await findChatwootCandidates(admin(), CONTACT_A, d), { ok: false, code: "chatwoot_unreachable" });
  });
});

// ── render ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("render: the contact page card", () => {
  const cand = [{ chatwootContactId: 501, name: "Test Customer", matchedOn: ["phone" as const], conversationId: 41, status: "open", lastActivityAt: 1_760_000_000 }];
  test("linked: 'Open in Chatwoot' opens the conversation in a new tab; no candidate wording", () => {
    const html = renderToString(<ChatwootLinkView view={{ kind: "linked", url: "https://chat.example.test/app/accounts/2/conversations/41", conversationId: 41, confirmedAt: "2026-10-21T12:00:00.000Z" }} canConfirm={false} />);
    assert.match(html, /Open in Chatwoot/);
    assert.match(html, /href="https:\/\/chat\.example\.test\/app\/accounts\/2\/conversations\/41"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /unconfirmed/);
  });
  test("candidates only: 'Possible Chatwoot matches (unconfirmed)' with a confirm action for an owner/admin; never 'Open in Chatwoot'", () => {
    const html = renderToString(<ChatwootLinkView view={{ kind: "candidates", candidates: cand }} canConfirm />);
    assert.match(html, /Possible Chatwoot matches \(unconfirmed\)/);
    assert.match(html, /Confirm same customer/);
    assert.match(html, /conversation #(<!-- -->)?41/); // React SSR separates adjacent text nodes with <!-- -->
    assert.doesNotMatch(html, /Open in Chatwoot/);
    assert.doesNotMatch(html, /href=/, "an unconfirmed candidate is not a link");
  });
  test("candidates for a member: no confirm button (control: the owner/admin render above has one)", () => {
    const html = renderToString(<ChatwootLinkView view={{ kind: "candidates", candidates: cand }} canConfirm={false} />);
    assert.match(html, /Possible Chatwoot matches \(unconfirmed\)/);
    assert.doesNotMatch(html, /Confirm same customer/);
    assert.match(html, /owner or admin can confirm/);
  });
  test("none and checking render nothing (control: linked renders something)", () => {
    assert.equal(renderToString(<ChatwootLinkView view={{ kind: "none" }} canConfirm />), "");
    assert.equal(renderToString(<ChatwootLinkView view={{ kind: "checking" }} canConfirm />), "");
    assert.notEqual(renderToString(<ChatwootLinkView view={{ kind: "linked", url: "https://x.test/app/accounts/2/conversations/1", conversationId: 1, confirmedAt: "2026-10-21T00:00:00Z" }} canConfirm />), "");
  });
  test("lookup failure says it could not check; it is not presented as 'no conversation' or as a link", () => {
    const html = renderToString(<ChatwootLinkView view={{ kind: "error" }} canConfirm />);
    assert.match(html, /could not be checked/);
    assert.doesNotMatch(html, /Open in Chatwoot|href=/);
  });
});
