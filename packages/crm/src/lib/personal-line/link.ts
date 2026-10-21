// EPIC 2026-10-21 — Personal Line: the ONLY writer of external_identities. REUSED from the 2026-10-11 account slice
// (isola-seldonframe#12 lib/personal-line/link.ts); only the input names changed (subject id + optional verified phone).
//
// Called by the signed Personal Line webhook (lib/personal-line/lifecycle.ts) after the HMAC verified. The subject is the
// plsvc users.id that owns the line; the wa_id is Meta-verified by plsvc (server-to-server) and becomes the phone.
//
// THE RULE THIS FILE KEEPS: an existing contact is NEVER adopted because its phone (or email) matches. A contact's
// phone may have been typed into an intake form by anyone; linking it would hand someone else's line to whoever
// controls that contact. So:
//   - identity already exists for (org, personal_line, subject) -> reuse ITS contact (refresh the verified phone)
//   - otherwise                                                 -> create a NEW contact, then the identity row
// Crash-safe and race-safe without a transaction (the neon-http driver has none) — Codex r1 P1: the new contact's id is
// DETERMINISTIC per (workspace, provider, subject), and both inserts are ON CONFLICT DO NOTHING. A crash between the
// contact insert and the identity insert, a replay, or two concurrent first events all converge on the SAME contact
// row; nothing is ever deleted.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

export const PL_PROVIDER = "personal_line";

/** PURE. The contact id a subject gets in a workspace: a name-based UUID (v5 layout) over (org, provider, subject). */
export function subjectContactId(orgId: string, provider: string, subjectId: string): string {
  const h = createHash("sha256").update(`uplink-external-contact-v1|${orgId.toLowerCase()}|${provider}|${subjectId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type LinkInput = { subjectId: string; waId: string | null; displayName: string | null };
export type LinkResult =
  | { ok: true; contactId: string; created: boolean }
  | { ok: false; reason: "contact_missing" | "conflict" };

export interface LinkStore {
  findIdentityByExternal(orgId: string, provider: string, externalId: string): Promise<{ contactId: string } | null>;
  contactExists(orgId: string, contactId: string): Promise<boolean>;
  setContactPhone(orgId: string, contactId: string, phone: string): Promise<void>;
  /** Insert the contact with exactly this id; a no-op if it already exists. */
  createContact(orgId: string, c: { id: string; firstName: string; phone: string | null; source: string }): Promise<void>;
  /** true = inserted; false = a unique index already held this (subject or contact). */
  insertIdentity(orgId: string, provider: string, externalId: string, contactId: string): Promise<boolean>;
}

export async function linkPersonalLine(orgId: string, input: LinkInput, store: LinkStore): Promise<LinkResult> {
  const phone = input.waId ? `+${input.waId}` : null;
  const existing = await store.findIdentityByExternal(orgId, PL_PROVIDER, input.subjectId);
  if (existing) {
    if (!(await store.contactExists(orgId, existing.contactId))) return { ok: false, reason: "contact_missing" };
    if (phone) await store.setContactPhone(orgId, existing.contactId, phone);
    return { ok: true, contactId: existing.contactId, created: false };
  }
  const contactId = subjectContactId(orgId, PL_PROVIDER, input.subjectId);
  await store.createContact(orgId, { id: contactId, firstName: input.displayName ?? "Personal Line subscriber", phone, source: "personal_line" });
  if (await store.insertIdentity(orgId, PL_PROVIDER, input.subjectId, contactId)) {
    return { ok: true, contactId, created: true };
  }
  const winner = await store.findIdentityByExternal(orgId, PL_PROVIDER, input.subjectId);
  return winner ? { ok: true, contactId: winner.contactId, created: false } : { ok: false, reason: "conflict" };
}

/** The production store over the app's drizzle client. Imported lazily so unit tests never load the DB module. */
export async function drizzleLinkStore(): Promise<LinkStore> {
  const { db } = await import("@/db");
  const { contacts, externalIdentities } = await import("@/db/schema");
  return {
    async findIdentityByExternal(orgId, provider, externalId) {
      const [row] = await db
        .select({ contactId: externalIdentities.contactId })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.orgId, orgId), eq(externalIdentities.provider, provider), eq(externalIdentities.externalId, externalId)))
        .limit(1);
      return row ?? null;
    },
    async contactExists(orgId, contactId) {
      const [row] = await db.select({ id: contacts.id }).from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId))).limit(1);
      return Boolean(row);
    },
    async setContactPhone(orgId, contactId, phone) {
      await db.update(contacts).set({ phone, updatedAt: new Date() })
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)));
    },
    async createContact(orgId, c) {
      await db.insert(contacts)
        .values({ id: c.id, orgId, firstName: c.firstName, phone: c.phone, source: c.source })
        .onConflictDoNothing();
    },
    async insertIdentity(orgId, provider, externalId, contactId) {
      const rows = await db.insert(externalIdentities)
        .values({ orgId, provider, externalId, contactId })
        .onConflictDoNothing()
        .returning({ id: externalIdentities.id });
      return rows.length === 1;
    },
  };
}
