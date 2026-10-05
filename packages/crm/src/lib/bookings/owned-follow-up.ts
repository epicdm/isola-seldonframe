// EPIC 2026-10-04 -- every public booking must leave an OWNED follow-up.
//
// A booking recorded by a visitor is not a confirmation (no email/SMS is sent automatically), so a person must
// pick it up. This records a staff task assigned to the workspace's first staff user and fills an EMPTY
// assignment on the contact and deal (never overwrites an existing assignee). Idempotent per booking.

export type FollowUpStore = {
  findOwner(orgId: string): Promise<{ id: string } | null>;
  hasTaskForBooking(orgId: string, bookingId: string): Promise<boolean>;
  findDealIdForBooking(orgId: string, bookingId: string): Promise<string | null>;
  insertTask(row: {
    orgId: string;
    userId: string;
    contactId: string | null;
    dealId: string | null;
    subject: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  assignIfEmpty(orgId: string, contactId: string | null, dealId: string | null, userId: string): Promise<void>;
};

export type FollowUpResult =
  | { recorded: true; assignedTo: string; created: boolean }
  | { recorded: false; reason: "no_staff_user" | "store_error" };

/**
 * Pick the follow-up owner from a workspace's users (oldest first). When a responder email is configured
 * (FOLLOW_UP_RESPONDER_EMAIL) it is authoritative: no match means NO owner (fail closed) and never a fall back to the
 * oldest user, which is the placeholder account. Unset keeps the earlier behaviour (oldest user).
 */
export function pickFollowUpOwner(users: Array<{ id: string; email: string }>, responderEmail: string | null | undefined): string | null {
  const want = (responderEmail ?? "").trim().toLowerCase();
  if (want) return users.find((u) => u.email.trim().toLowerCase() === want)?.id ?? null;
  return users[0]?.id ?? null;
}

/** Resolve who would own the follow-up, BEFORE the booking is written. */
export async function resolveFollowUpOwner(store: FollowUpStore, orgId: string): Promise<string | null> {
  const owner = await store.findOwner(orgId);
  return owner?.id ?? null;
}

export async function recordOwnedBookingFollowUp(
  store: FollowUpStore,
  input: {
    orgId: string;
    contactId: string | null;
    bookingId: string;
    fullName: string;
    startsAtIso: string;
    contactBits: Array<string | null | undefined>;
  },
): Promise<FollowUpResult> {
  try {
    const ownerId = await resolveFollowUpOwner(store, input.orgId);
    if (!ownerId) return { recorded: false, reason: "no_staff_user" };
    const dealId = await store.findDealIdForBooking(input.orgId, input.bookingId);
    let created = false;
    if (!(await store.hasTaskForBooking(input.orgId, input.bookingId))) {
      const contact = input.contactBits.filter((b): b is string => typeof b === "string" && b.length > 0).join(", ");
      await store.insertTask({
        orgId: input.orgId,
        userId: ownerId,
        contactId: input.contactId,
        dealId,
        subject: "Booking follow-up required",
        body: `Booking request from ${input.fullName} for ${input.startsAtIso} (${contact || "no contact details"}). It is recorded but NOT confirmed: no confirmation email or text is sent automatically. Contact the customer to confirm the time.`,
        metadata: { source: "public-booking-follow-up", bookingId: input.bookingId, assignedTo: ownerId },
      });
      created = true;
    }
    await store.assignIfEmpty(input.orgId, input.contactId, dealId, ownerId);
    return { recorded: true, assignedTo: ownerId, created };
  } catch {
    return { recorded: false, reason: "store_error" };
  }
}

export type EnquiryResult =
  | { recorded: true; assignedTo: string }
  | { recorded: false; reason: "no_staff_user" | "store_error" };

/**
 * An agent hand-off ("a person should follow up") must leave an OWNED, open task. Without one the visitor is told a
 * human will follow up while nothing was recorded. The task is attached to the contact when one is known; otherwise the
 * visitor's own details travel in the task body so staff can act.
 */
export async function recordOwnedEnquiry(
  store: FollowUpStore,
  input: {
    orgId: string;
    contactId: string | null;
    conversationId: string;
    agentId: string;
    reason: string;
    contactBits: Array<string | null | undefined>;
  },
): Promise<EnquiryResult> {
  try {
    const ownerId = await resolveFollowUpOwner(store, input.orgId);
    if (!ownerId) return { recorded: false, reason: "no_staff_user" };
    const contact = input.contactBits.filter((b): b is string => typeof b === "string" && b.length > 0).join(", ");
    await store.insertTask({
      orgId: input.orgId,
      userId: ownerId,
      contactId: input.contactId,
      dealId: null,
      subject: "Enquiry needs a person",
      body: `${input.reason}\n\nContact: ${contact || "none given"}\nConversation: ${input.conversationId}`,
      metadata: { source: "agent-escalation", conversationId: input.conversationId, agentId: input.agentId, assignedTo: ownerId },
    });
    return { recorded: true, assignedTo: ownerId };
  } catch {
    return { recorded: false, reason: "store_error" };
  }
}

/**
 * A form enquiry (e.g. "Get started with Isola") must leave ONE owned, open task and fill an EMPTY contact assignment.
 * It states plainly that nothing has been activated or charged: a person must contact the customer first.
 */
export async function recordOwnedFormFollowUp(
  store: FollowUpStore,
  input: {
    orgId: string;
    contactId: string;
    formId: string;
    formName: string;
    service: string | null;
    details: string | null;
    contactBits: Array<string | null | undefined>;
  },
): Promise<EnquiryResult> {
  try {
    const ownerId = await resolveFollowUpOwner(store, input.orgId);
    if (!ownerId) return { recorded: false, reason: "no_staff_user" };
    const service = (input.service ?? "").trim();
    const subject = /^personal line/i.test(service) ? "Personal Line activation follow-up" : "Enquiry follow-up";
    const contact = input.contactBits.filter((b): b is string => typeof b === "string" && b.length > 0).join(", ");
    await store.insertTask({
      orgId: input.orgId,
      userId: ownerId,
      contactId: input.contactId,
      dealId: null,
      subject,
      body: `New "${input.formName}" submission.\nService: ${service || "not stated"}\nContact: ${contact || "none given"}\nDetails: ${(input.details ?? "").slice(0, 500) || "none"}\n\nNothing has been activated or charged. A person must contact the customer to confirm the details first.`,
      metadata: { source: "intake-form", formId: input.formId, assignedTo: ownerId },
    });
    await store.assignIfEmpty(input.orgId, input.contactId, null, ownerId);
    return { recorded: true, assignedTo: ownerId };
  } catch {
    return { recorded: false, reason: "store_error" };
  }
}

/** The real store (lazy imports keep this module importable without a database in tests). */
export function drizzleFollowUpStore(): FollowUpStore {
  return {
    async findOwner(orgId) {
      const { db } = await import("@/db");
      const { users } = await import("@/db/schema");
      const { eq, asc } = await import("drizzle-orm");
      const rows = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.orgId, orgId)).orderBy(asc(users.createdAt));
      const id = pickFollowUpOwner(rows, process.env.FOLLOW_UP_RESPONDER_EMAIL);
      return id ? { id } : null;
    },
    async hasTaskForBooking(orgId, bookingId) {
      const { db } = await import("@/db");
      const { activities } = await import("@/db/schema");
      const { and, eq, sql } = await import("drizzle-orm");
      const rows = await db
        .select({ id: activities.id })
        .from(activities)
        .where(and(eq(activities.orgId, orgId), eq(activities.type, "task"), sql`${activities.metadata} ->> 'bookingId' = ${bookingId}`))
        .limit(1);
      return rows.length > 0;
    },
    async findDealIdForBooking(orgId, bookingId) {
      const { db } = await import("@/db");
      const { deals } = await import("@/db/schema");
      const { and, eq, sql } = await import("drizzle-orm");
      const rows = await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), sql`${deals.customFields} ->> 'bookingId' = ${bookingId}`))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    async insertTask(row) {
      const { db } = await import("@/db");
      const { activities } = await import("@/db/schema");
      await db.insert(activities).values({
        orgId: row.orgId,
        userId: row.userId,
        contactId: row.contactId,
        dealId: row.dealId,
        type: "task",
        subject: row.subject,
        body: row.body,
        metadata: row.metadata,
      });
    },
    async assignIfEmpty(orgId, contactId, dealId, userId) {
      const { db } = await import("@/db");
      const { contacts, deals } = await import("@/db/schema");
      const { and, eq, isNull } = await import("drizzle-orm");
      if (contactId) {
        await db.update(contacts).set({ assignedTo: userId }).where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId), isNull(contacts.assignedTo)));
      }
      if (dealId) {
        await db.update(deals).set({ assignedTo: userId }).where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.assignedTo)));
      }
    },
  };
}
