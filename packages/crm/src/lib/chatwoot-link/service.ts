// Chatwoot customer link: the core. Injectable (this repo's DI convention), so the server actions and the page call exactly this code.
//
// Rules:
//  * Everything is keyed on (workspace from the SESSION, Uplink contact id). The contact is read with BOTH in the WHERE clause first; a
//    contact of another workspace is "not found" and no Chatwoot call is made for it.
//  * A link is shown only from a verified, person-confirmed record (record.ts). Phone/email matches are only ever CANDIDATES.
//  * Confirming re-runs the candidate lookup on the server and accepts only a (Chatwoot contact, conversation) pair that is a current
//    candidate for this contact: a crafted request cannot link an arbitrary conversation.
//  * Only a real workspace owner/admin can confirm (not an admin-token or operator-portal session: a person must confirm).
//  * Chatwoot is only ever READ (reader.ts has no write method). The only write is one activities row in Uplink.
import { randomUUID } from "node:crypto";

import { canConfirmChatwootLink } from "./actor";
import { chatwootConversationUrl, type ChatwootLinkTarget, type ChatwootLookupConfig } from "./config";
import { CHATWOOT_LINK_ACTIVITY_TYPE, chatwootLinkMetadata, verifyChatwootLink, type ChatwootLinkRecord } from "./record";
import type { ChatwootReader } from "./reader";

export type LinkContact = { id: string; orgId: string; firstName: string; lastName: string | null; email: string | null; phone: string | null };
export type LinkActivityRow = { id: string; orgId: string; contactId: string | null; metadata: unknown };

export interface ChatwootLinkStore {
  /** The contact, only if it belongs to orgId. */
  getContact(orgId: string, contactId: string): Promise<LinkContact | null>;
  /** This contact's chatwoot_link_confirmed rows in orgId, newest first, one page (limit/offset). */
  linkActivities(orgId: string, contactId: string, limit: number, offset: number): Promise<LinkActivityRow[]>;
  /** Inserts with the given id: the signature is bound to it. */
  insertLinkActivity(a: { id: string; orgId: string; contactId: string; userId: string; subject: string; metadata: Record<string, unknown> }): Promise<void>;
}

export type ChatwootLinkDeps = {
  store: ChatwootLinkStore;
  target: ChatwootLinkTarget | null;
  lookup: ChatwootLookupConfig | null;
  reader: ChatwootReader | null;
  key: string | null;
  now: () => Date;
  /** Activity row id generator (default randomUUID). */
  newId?: () => string;
};

export type LinkState =
  | { state: "unavailable" }
  | { state: "unlinked" }
  | { state: "linked"; url: string; conversationId: number; confirmedAt: string };

export type Candidate = {
  chatwootContactId: number;
  name: string | null;
  matchedOn: Array<"phone" | "email">;
  conversationId: number;
  status: string | null;
  lastActivityAt: number | null;
};

export type Actor = { orgId: string; userId: string; role: string; realPerson: boolean };

/** incomplete: Chatwoot had more search pages than the lookup budget; some matches may not be listed. */
export type FindResult = { ok: true; candidates: Candidate[]; incomplete: boolean } | { ok: false; code: "not_found" | "unavailable" | "chatwoot_unreachable" };
export type ConfirmResult =
  | { ok: true; link: Extract<LinkState, { state: "linked" }> }
  | { ok: false; code: "not_found" | "unavailable" | "forbidden" | "not_a_candidate" | "chatwoot_unreachable" | "invalid" };

const MAX_CONTACTS = 5;
// The contact's chatwoot_link_confirmed rows are read newest first, a page at a time, until one verifies or history ends. Rows written by
// other paths never verify. LINK_SCAN_MAX_PAGES only bounds the work under a deliberate flood of 10,000+ rows on one contact; an exhausted
// scan is "unavailable" (the card is not shown at all), never "unlinked" (which would offer candidates as if no link existed) and never a
// wrong link.
const LINK_SCAN_PAGE = 200;
const LINK_SCAN_MAX_PAGES = 50;
const MAX_CONVERSATIONS_PER_CONTACT = 10;
const CHATWOOT_CONVERSATIONS_CAP = 25; // v4.18 Contacts::ConversationsController::RESULTS_PER_PAGE: a full page may hide older ones
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Digits of a phone number, with a leading NANP "1" dropped from 11-digit numbers so "+1 767 295 6737" equals "767-295-6737". */
export function phoneKey(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length < 7 || d.length > 15) return null;
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export function emailKey(v: string | null | undefined): string | null {
  const e = (v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** The confirmed link for this contact, if any. Reads Uplink only; never calls Chatwoot. */
export async function getChatwootLinkState(orgId: string, contactId: string, deps: ChatwootLinkDeps): Promise<LinkState> {
  if (!deps.target || !deps.key || !UUID.test(contactId)) return { state: "unavailable" };
  const contact = await deps.store.getContact(orgId, contactId);
  if (!contact) return { state: "unavailable" };
  const found = await currentLink(orgId, contactId, deps.store, deps.target, deps.key);
  if (found === "exhausted") return { state: "unavailable" };
  return found ? linked(deps.target, found) : { state: "unlinked" };
}

async function currentLink(
  orgId: string,
  contactId: string,
  store: ChatwootLinkStore,
  target: ChatwootLinkTarget,
  key: string,
): Promise<ChatwootLinkRecord | null | "exhausted"> {
  for (let page = 0; page < LINK_SCAN_MAX_PAGES; page++) {
    const rows = await store.linkActivities(orgId, contactId, LINK_SCAN_PAGE, page * LINK_SCAN_PAGE);
    for (const row of rows) {
      const rec = verifyChatwootLink(row, { orgId, contactId, accountId: target.accountId }, key);
      if (rec) return rec;
    }
    if (rows.length < LINK_SCAN_PAGE) return null;
  }
  return "exhausted";
}

function linked(target: ChatwootLinkTarget, rec: ChatwootLinkRecord): Extract<LinkState, { state: "linked" }> {
  return { state: "linked", url: chatwootConversationUrl(target, rec.conversationId), conversationId: rec.conversationId, confirmedAt: rec.confirmedAt };
}

/** Possible matches by exact phone or email. Never by name. Never auto-linked. */
export async function findChatwootCandidates(actor: Pick<Actor, "orgId">, contactId: string, deps: ChatwootLinkDeps): Promise<FindResult> {
  if (!UUID.test(contactId)) return { ok: false, code: "not_found" };
  const contact = await deps.store.getContact(actor.orgId, contactId);
  if (!contact) return { ok: false, code: "not_found" };
  if (!deps.lookup || !deps.reader || !deps.key) return { ok: false, code: "unavailable" };
  try {
    const r = await lookupCandidates(contact, deps.reader);
    return { ok: true, candidates: r.candidates, incomplete: r.incomplete };
  } catch {
    return { ok: false, code: "chatwoot_unreachable" };
  }
}

async function lookupCandidates(contact: LinkContact, reader: ChatwootReader): Promise<{ candidates: Candidate[]; incomplete: boolean }> {
  const phone = phoneKey(contact.phone);
  const email = emailKey(contact.email);
  const matched = new Map<number, { name: string | null; on: Set<"phone" | "email"> }>();
  const note = (id: number, name: string | null, on: "phone" | "email") => {
    const m = matched.get(id) ?? { name, on: new Set() };
    m.on.add(on);
    matched.set(id, m);
  };
  let incomplete = false;
  if (phone) {
    const r = await reader.searchContacts(phone);
    incomplete ||= !r.complete;
    for (const c of r.contacts) if (phoneKey(c.phone) === phone) note(c.id, c.name, "phone");
  }
  if (email) {
    const r = await reader.searchContacts(email);
    incomplete ||= !r.complete;
    for (const c of r.contacts) if (emailKey(c.email) === email) note(c.id, c.name, "email");
  }
  if (matched.size > MAX_CONTACTS) incomplete = true;
  const out: Candidate[] = [];
  for (const [chatwootContactId, m] of [...matched.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_CONTACTS)) {
    const all = await reader.contactConversations(chatwootContactId);
    if (all.length >= CHATWOOT_CONVERSATIONS_CAP || all.length > MAX_CONVERSATIONS_PER_CONTACT) incomplete = true;
    const convs = all
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || b.displayId - a.displayId)
      .slice(0, MAX_CONVERSATIONS_PER_CONTACT);
    for (const c of convs) {
      out.push({
        chatwootContactId,
        name: m.name,
        matchedOn: (["phone", "email"] as const).filter((k) => m.on.has(k)),
        conversationId: c.displayId,
        status: c.status,
        lastActivityAt: c.lastActivityAt,
      });
    }
  }
  return { candidates: out, incomplete };
}

/** A person confirms one candidate. Writes one Uplink activity; never writes to Chatwoot. */
export async function confirmChatwootLink(
  actor: Actor,
  input: { contactId: unknown; chatwootContactId: unknown; conversationId: unknown },
  deps: ChatwootLinkDeps,
): Promise<ConfirmResult> {
  const contactId = typeof input.contactId === "string" && UUID.test(input.contactId) ? input.contactId : null;
  const cwContact = typeof input.chatwootContactId === "number" && Number.isInteger(input.chatwootContactId) && input.chatwootContactId > 0 ? input.chatwootContactId : null;
  const conv = typeof input.conversationId === "number" && Number.isInteger(input.conversationId) && input.conversationId > 0 ? input.conversationId : null;
  if (!contactId || !cwContact || !conv) return { ok: false, code: "invalid" };
  if (!canConfirmChatwootLink(actor)) return { ok: false, code: "forbidden" }; // the same rule the page uses to offer the button
  const contact = await deps.store.getContact(actor.orgId, contactId);
  if (!contact) return { ok: false, code: "not_found" };
  if (!deps.target || !deps.lookup || !deps.reader || !deps.key) return { ok: false, code: "unavailable" };
  let candidates: Candidate[];
  try {
    candidates = (await lookupCandidates(contact, deps.reader)).candidates;
  } catch {
    return { ok: false, code: "chatwoot_unreachable" };
  }
  if (!candidates.some((c) => c.chatwootContactId === cwContact && c.conversationId === conv)) return { ok: false, code: "not_a_candidate" };
  // Idempotent: confirming the pair that is already the current link (a retry, a double click) returns it and writes nothing.
  const existing = await currentLink(actor.orgId, contactId, deps.store, deps.target, deps.key);
  if (existing && existing !== "exhausted" && existing.chatwootContactId === cwContact && existing.conversationId === conv) {
    return { ok: true, link: linked(deps.target, existing) };
  }
  const rowId = (deps.newId ?? randomUUID)();
  const rec: ChatwootLinkRecord = {
    rowId,
    orgId: actor.orgId,
    uplinkContactId: contactId,
    accountId: deps.target.accountId,
    chatwootContactId: cwContact,
    conversationId: conv,
    confirmedByUserId: actor.userId,
    confirmedAt: deps.now().toISOString(),
  };
  await deps.store.insertLinkActivity({
    id: rowId,
    orgId: actor.orgId,
    contactId,
    userId: actor.userId,
    subject: `Linked to Chatwoot conversation #${conv}`,
    metadata: chatwootLinkMetadata(rec, deps.key),
  });
  return { ok: true, link: linked(deps.target, rec) };
}

export { CHATWOOT_LINK_ACTIVITY_TYPE };
