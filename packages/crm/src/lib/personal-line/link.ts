// EPIC 2026-10-11 — Personal Line subscriber account slice (2a): the ONLY writer of external_identities.
//
// Called by the signed Personal Line webhook (lib/personal-line/events.ts) after the HMAC verified. The subject is the plsvc liteAccount id; the wa_id is
// Meta-verified by plsvc (server-to-server) and becomes the contact's phone.
//
// THE RULE THIS FILE KEEPS: an existing contact is NEVER adopted because its phone (or email) matches. A contact's
// phone may have been typed into an intake form by anyone; linking it would let whoever controls that contact's email
// sign in and see someone else's line. So:
//   - identity already exists for (org, personal_line, pl_account_id)  -> reuse ITS contact (refresh the verified phone)
//   - otherwise                                                        -> create a NEW contact, then the identity row
// Race-safe without a transaction (the neon-http driver has none): the identity insert is ON CONFLICT DO NOTHING on
// the two unique indexes; the loser deletes the contact it just created and re-reads the winner.
import { and, eq } from "drizzle-orm";

export const PL_PROVIDER = "personal_line";

export type LinkInput = { plAccountId: string; waId: string; displayName: string | null };
export type LinkResult =
  | { ok: true; contactId: string; created: boolean }
  | { ok: false; reason: "contact_missing" | "conflict" };

export interface LinkStore {
  findIdentityByExternal(orgId: string, provider: string, externalId: string): Promise<{ contactId: string } | null>;
  contactExists(orgId: string, contactId: string): Promise<boolean>;
  setContactPhone(orgId: string, contactId: string, phone: string): Promise<void>;
  createContact(orgId: string, c: { firstName: string; phone: string; source: string }): Promise<string>;
  /** true = inserted; false = a unique index already held this (subject or contact). */
  insertIdentity(orgId: string, provider: string, externalId: string, contactId: string): Promise<boolean>;
  deleteContact(orgId: string, contactId: string): Promise<void>;
}

export async function linkPersonalLine(orgId: string, input: LinkInput, store: LinkStore): Promise<LinkResult> {
  const phone = `+${input.waId}`;
  const existing = await store.findIdentityByExternal(orgId, PL_PROVIDER, input.plAccountId);
  if (existing) {
    if (!(await store.contactExists(orgId, existing.contactId))) return { ok: false, reason: "contact_missing" };
    await store.setContactPhone(orgId, existing.contactId, phone);
    return { ok: true, contactId: existing.contactId, created: false };
  }
  const contactId = await store.createContact(orgId, {
    firstName: input.displayName ?? "Personal Line subscriber",
    phone,
    source: "personal_line",
  });
  if (await store.insertIdentity(orgId, PL_PROVIDER, input.plAccountId, contactId)) {
    return { ok: true, contactId, created: true };
  }
  // Lost a race (or the subject was linked between our read and write): remove the contact we just made, use the winner.
  await store.deleteContact(orgId, contactId);
  const winner = await store.findIdentityByExternal(orgId, PL_PROVIDER, input.plAccountId);
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
