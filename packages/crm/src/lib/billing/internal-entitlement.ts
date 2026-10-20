// EPIC 2026-10-20 — billing DISPLAY for an internal (payment-off) entitlement. Read-only: it reads the audited
// internal_entitlement record (workspace_admin_actions, migration 0080) and the workspace subscription; it never writes plans,
// quotas, pricing, payment collection or Stripe records. Port plan-epic-execution-control-current-2026-10-20 (v1.7, billing gap 5b).

import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { workspaceAdminActions, type OrganizationSubscription } from "@/db/schema";
import { normalizeTierId, type BillingTier } from "./features";

/** The latest applied, unreverted internal_entitlement record of a workspace (what the audited action wrote as its after-state). */
export type InternalEntitlementRecord = { actionId: string; tier: string | null; paymentCollection: string | null };

/** The subscription carries any Stripe link (the same test the entitlement action uses to refuse a Stripe-managed workspace). */
export function hasStripeLink(subscription: OrganizationSubscription): boolean {
  return Boolean(subscription.stripeSubscriptionId || subscription.stripeCustomerId || subscription.stripePriceId);
}

/**
 * An internal entitlement is in effect only while the live subscription still matches its record: the record says payment
 * collection is off, the subscription is active, on the same tier, and has no Stripe link. Anything else (a later Stripe
 * checkout, a reversal, a tier change, no record) falls back to the normal paid/free display.
 */
export function isInternalEntitlementInEffect(
  subscription: OrganizationSubscription,
  record: InternalEntitlementRecord | null,
): boolean {
  if (!record || record.paymentCollection !== "off") return false;
  if (hasStripeLink(subscription)) return false;
  if (subscription.status !== "active") return false;
  const live = normalizeTierId(subscription.tier);
  return live !== "inactive" && live === normalizeTierId(record.tier);
}

/**
 * Whether the billing-portal action would find a Stripe customer for this caller. It mirrors createBillingPortalSessionAction
 * (lib/billing/actions.ts): the workspace's own customer is used only for an owner-like caller; anyone else falls back to their
 * personal customer. Codex r1 (2026-10-20): an invited member of a paid workspace with no personal customer must not be offered a
 * button the action can only redirect.
 */
export function portalCustomerExists(input: {
  workspaceCustomerId?: string | null;
  callerIsOwnerLike: boolean;
  callerCustomerId?: string | null;
}): boolean {
  const workspace = input.workspaceCustomerId && input.callerIsOwnerLike ? input.workspaceCustomerId : null;
  return Boolean(workspace ?? input.callerCustomerId);
}

export type BillingPresentation = { internalPlan: boolean; showManageSubscription: boolean };

/**
 * What the billing page shows. "Manage subscription" opens the Stripe billing portal, so it is offered only when a Stripe
 * customer exists for the caller (the workspace's or the user's own - the same two the portal action reads); the paid-tier and
 * guest-admin-token conditions are unchanged.
 */
export function billingPresentation(input: {
  subscription: OrganizationSubscription;
  record: InternalEntitlementRecord | null;
  tier: BillingTier;
  isGuestAdminToken: boolean;
  hasStripeCustomer: boolean;
}): BillingPresentation {
  return {
    internalPlan: isInternalEntitlementInEffect(input.subscription, input.record),
    showManageSubscription: !input.isGuestAdminToken && input.tier !== "inactive" && input.hasStripeCustomer,
  };
}

/**
 * True when `orgId`'s current subscription comes from an audited internal grant (see isInternalEntitlementInEffect). Used by the
 * tier resolver so an internal grant is not inherited by the owner's other workspaces. Requires the audit record; missing Stripe
 * data alone never makes a subscription "internal". On a read failure the reader returns null, so this returns false (the
 * pre-change inheritance behaviour) rather than blocking tier resolution.
 */
export async function internalGrantInEffectFor(orgId: string, subscription: unknown): Promise<boolean> {
  const record = await findActiveInternalEntitlement(orgId);
  return isInternalEntitlementInEffect((subscription ?? {}) as OrganizationSubscription, record);
}

/** Reads the latest applied internal_entitlement of the workspace that no applied reversal points at. Null on any failure
 *  (the page then shows the normal display; it never blocks billing). */
export async function findActiveInternalEntitlement(orgId: string | null | undefined): Promise<InternalEntitlementRecord | null> {
  if (!orgId) return null;
  try {
    const reversal = alias(workspaceAdminActions, "reversal");
    const [row] = await db
      .select({ id: workspaceAdminActions.id, after: workspaceAdminActions.after })
      .from(workspaceAdminActions)
      .where(
        and(
          eq(workspaceAdminActions.orgId, orgId),
          eq(workspaceAdminActions.action, "internal_entitlement"),
          eq(workspaceAdminActions.outcome, "applied"),
          isNull(workspaceAdminActions.revertsActionId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(reversal)
              .where(
                and(
                  eq(reversal.revertsActionId, workspaceAdminActions.id),
                  eq(reversal.action, "internal_entitlement"),
                  eq(reversal.outcome, "applied"),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(workspaceAdminActions.createdAt))
      .limit(1);
    if (!row) return null;
    const after = (row.after ?? {}) as Record<string, unknown>;
    return {
      actionId: row.id,
      tier: typeof after.tier === "string" ? after.tier : null,
      paymentCollection: typeof after.paymentCollection === "string" ? after.paymentCollection : null,
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "billing_internal_entitlement_read_failed", org_id: orgId, error: String(error).slice(0, 200) }));
    return null;
  }
}
