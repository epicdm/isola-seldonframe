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
// Race-safe without a transaction (the neon-http driver has none): the identity insert is ON CONFLICT DO NOTHING on
// the two unique indexes; the loser deletes the contact it just created and re-reads the winner.
import { and, eq } from "drizzle-orm";

export const PL_PROVIDER = "personal_line";

export type LinkInput = { subjectId: string; waId: string | null; displayName: string | null };
export type LinkResult =
  | { ok: true; contactId: string; created: boolean }
  | { ok: false; reason: "contact_missing" | "conflict" };

export interface LinkStore {
  findIdentityByExternal(orgId: string, provider: string, externalId: string): Promise<{ contactId: string } | null>;
  contactExists(orgId: string, contactId: string): Promise<boolean>;
  setContactPhone(orgId: string, contactId: string, phone: string): Promise<void>;
  createContact(orgId: string, c: { firstName: string; phone: string | null; source: string }): Promise<string>;
  /** true = inserted; false = a unique index already held this (subject or contact). */
  insertIdentity(orgId: string, provider: string, externalId: string, contactId: string): Promise<boolean>;
  deleteContact(orgId: string, contactId: string): Promise<void>;
}

export async function linkPersonalLine(orgId: string, input: LinkInput, store: LinkStore): Promise<LinkResult> {
  const phone = input.waId ? `+${input.waId}` : null;
  const existing = await store.findIdentityByExternal(orgId, PL_PROVIDER, input.subjectId);
  if (existing) {
    if (!(await store.contactExists(orgId, existing.contactId))) return { ok: false, reason: "contact_missing" };
    if (phone) await store.setContactPhone(orgId, existing.contactId, phone);
    return { ok: true, contactId: existing.contactId, created: false };
  }
  const contactId = await store.createContact(orgId, {
    firstName: input.displayName ?? "Personal Line subscriber",
    phone,
    source: "personal_line",
  });
  if (await store.insertIdentity(orgId, PL_PROVIDER, input.subjectId, contactId)) {
    return { ok: true, contactId, created: true };
  }
  await store.deleteContact(orgId, contactId);
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
      const [row] = await db.insert(contacts)
        .values({ orgId, firstName: c.firstName, phone: c.phone, source: c.source })
        .returning({ id: contacts.id });
      return row.id;
    },
    async insertIdentity(orgId, provider, externalId, contactId) {
      const rows = await db.insert(externalIdentities)
        .values({ orgId, provider, externalId, contactId })
        .onConflictDoNothing()
        .returning({ id: externalIdentities.id });
      return rows.length === 1;
    },
    async deleteContact(orgId, contactId) {
      await db.delete(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)));
    },
  };
}
