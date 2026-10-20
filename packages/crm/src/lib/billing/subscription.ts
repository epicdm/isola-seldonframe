import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, type OrganizationSubscription } from "@/db/schema";

export type OrgSubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "unpaid";

/** The database handle or an open transaction (EPIC 2026-10-20: lets the audited internal-entitlement action reuse these helpers
 *  inside its own transaction). Omitted = the shared `db`, exactly as before. */
type SubscriptionDbClient = Pick<typeof db, "select" | "update">;

export async function getOrgSubscription(
  orgId: string | null | undefined,
  client: SubscriptionDbClient = db,
): Promise<OrganizationSubscription> {
  if (!orgId) {
    return {};
  }

  const [row] = await client
    .select({ subscription: organizations.subscription })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return row?.subscription ?? {};
}

export async function updateOrgSubscription(
  orgId: string | null | undefined,
  updates: Partial<OrganizationSubscription>,
  client: SubscriptionDbClient = db,
) {
  if (!orgId) {
    return;
  }

  const current = await getOrgSubscription(orgId, client);
  const next: OrganizationSubscription = {
    ...current,
    ...updates,
  };

  await client
    .update(organizations)
    .set({
      subscription: next,
      updatedAt: new Date(),
      ...(typeof updates.tier === "string" ? { plan: updates.tier } : {}),
    })
    .where(eq(organizations.id, orgId));
}
