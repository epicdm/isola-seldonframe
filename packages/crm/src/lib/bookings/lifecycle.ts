// 2026-10-21 — booking lifecycle CRM history (release 1: cancellation).
//
// appendBookingLifecycleActivity appends ONE activity row for a lifecycle
// outcome (e.g. booking_cancelled from the public management link). The
// original "Booked ..." activity is never touched. Callers gate it on the
// workspace's selected business calendar.
//
// Not a "use server" module.

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { activities, orgMembers, organizations, users } from "@/db/schema";

export type BookingLifecycleSource =
  | "booking_manage_link"
  | "customer_portal"
  | "admin_bookings"
  | "operator_portal"
  | "api";

/** activities.userId is NOT NULL. Anchor on the workspace owner
 *  (organizations.ownerId), else the first user whose primary org is this one
 *  (the existing booking/portal pattern), else the first org member — so a
 *  membership-only workspace still gets its history. */
async function resolveActivityUserId(orgId: string): Promise<string | null> {
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (org?.ownerId) return org.ownerId;
  const [primary] = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);
  if (primary?.id) return primary.id;
  const [member] = await db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(asc(orgMembers.createdAt))
    .limit(1);
  return member?.id ?? null;
}

export type LifecycleActivityInput = {
  orgId: string;
  contactId: string | null;
  bookingId: string;
  type: "booking_rescheduled" | "booking_cancelled";
  subject: string;
  body: string;
  source: BookingLifecycleSource;
  extraMetadata?: Record<string, unknown>;
  scheduledAt?: Date;
};

/** Append one CRM activity row. Never throws; returns whether it was written. */
export async function appendBookingLifecycleActivity(input: LifecycleActivityInput): Promise<boolean> {
  try {
    if (!input.contactId) return false;
    const userId = await resolveActivityUserId(input.orgId);
    if (!userId) {
      console.warn(
        JSON.stringify({
          event: "booking_lifecycle.activity_skipped",
          reason: "no_workspace_user",
          orgId: input.orgId,
          bookingId: input.bookingId,
          type: input.type,
        }),
      );
      return false;
    }
    await db.insert(activities).values({
      orgId: input.orgId,
      userId,
      contactId: input.contactId,
      type: input.type,
      subject: input.subject,
      body: input.body,
      metadata: { source: input.source, bookingId: input.bookingId, ...(input.extraMetadata ?? {}) },
      ...(input.type === "booking_cancelled" ? { completedAt: new Date() } : {}),
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    });
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "booking_lifecycle.activity_failed",
        orgId: input.orgId,
        bookingId: input.bookingId,
        type: input.type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
