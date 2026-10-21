"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { activities, contacts, deals, orgMembers, users } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";

export async function listActivities() {
  const orgId = await getOrgId();

  if (!orgId) {
    return [];
  }

  return db.select().from(activities).where(eq(activities.orgId, orgId)).orderBy(desc(activities.createdAt));
}

export async function createActivityAction(formData: FormData) {
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const contactId = (formData.get("contactId") as string | null) || null;
  const dealId = (formData.get("dealId") as string | null) || null;
  const userId = String(formData.get("userId") ?? "");

  // Every id in the form is checked against the session's workspace before
  // the write; an id from another workspace is refused like a missing one.
  if (contactId) {
    const [ownContact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
      .limit(1);
    if (!ownContact) throw new Error("Contact not found");
  }
  if (dealId) {
    const [ownDeal] = await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId)))
      .limit(1);
    if (!ownDeal) throw new Error("Deal not found");
  }
  // The UI always sends the signed-in user; any other user must belong to
  // this workspace (home org or member).
  if (!userId) throw new Error("User not found");
  const currentUser = await getCurrentUser();
  if (userId !== currentUser?.id) {
    const [homeUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.id, userId)))
      .limit(1);
    const [member] = homeUser
      ? [homeUser]
      : await db
          .select({ id: orgMembers.userId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
          .limit(1);
    if (!member) throw new Error("User not found");
  }

  await db.insert(activities).values({
    orgId,
    userId,
    contactId,
    dealId,
    type: String(formData.get("type") ?? "note"),
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    scheduledAt: formData.get("scheduledAt") ? new Date(String(formData.get("scheduledAt"))) : null,
  });

  // Revalidate so the contact page shows the new activity immediately.
  if (contactId) {
    revalidatePath(`/contacts/${contactId}`);
  }
  revalidatePath("/activities");
}

export async function completeTaskAction(activityId: string) {
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const [row] = await db
    .select({ contactId: activities.contactId })
    .from(activities)
    .where(and(eq(activities.orgId, orgId), eq(activities.id, activityId)))
    .limit(1);

  await db
    .update(activities)
    .set({ completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(activities.orgId, orgId), eq(activities.id, activityId)));

  if (row?.contactId) {
    revalidatePath(`/contacts/${row.contactId}`);
  }
}

/**
 * Persist operator notes on a specific activity.
 *
 * Storage: `activities.metadata.notes` (string inside existing jsonb).
 * Read-modify-write so other metadata keys are preserved.
 * Auth-scoped: activity must belong to the operator's orgId.
 */
export async function updateActivityNotesAction({
  activityId,
  notes,
}: {
  activityId: string;
  notes: string;
}) {
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  // Fetch existing metadata to preserve other keys.
  const [existing] = await db
    .select({ metadata: activities.metadata, contactId: activities.contactId })
    .from(activities)
    .where(and(eq(activities.orgId, orgId), eq(activities.id, activityId)))
    .limit(1);

  if (!existing) {
    throw new Error("Activity not found");
  }

  const updatedMetadata: Record<string, unknown> = {
    ...(existing.metadata ?? {}),
    notes: notes.trim(),
  };

  await db
    .update(activities)
    .set({ metadata: updatedMetadata, updatedAt: new Date() })
    .where(and(eq(activities.orgId, orgId), eq(activities.id, activityId)));

  if (existing.contactId) {
    revalidatePath(`/contacts/${existing.contactId}`);
  }
}
