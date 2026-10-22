// packages/crm/src/app/start/actions.ts
// Live-sell checkout server actions.
// Step 1 → Step 2: createLiveSellCheckoutAction
//   - Creates proposal record (reusing lib/proposals/create.ts)
//   - Creates Stripe Embedded Checkout session on the agency's connected account
//   - Returns client_secret + stripeAccount for the client-side EmbeddedCheckoutProvider
// Return page: applyOnboardingMiniFormAction
//   - Applies partial onboarding data (business details captured during the call)
//   - Uses existing buildChangePlan + applyChangePlan (no-ops on missing keys)

"use server";

import { and, eq, ilike } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { bookings, organizations, partnerAgencies, proposals, stripeConnections, users } from "@/db/schema";
import { createProposal } from "@/lib/proposals/create";
import { buildCheckoutSessionParams } from "@/lib/proposals/checkout";
import { getStripeClient } from "@/lib/proposals/stripe-connect";
import { buildChangePlan } from "@/lib/onboarding/change-plan";
import { applyChangePlan } from "@/lib/onboarding/execute-change-plan";
import { logEvent } from "@/lib/observability/log";
import { userCanAccessOrg } from "@/lib/auth/helpers";
import { getOrgSubscription } from "@/lib/billing/subscription";
import { normalizeTierId } from "@/lib/billing/features";

// ─── constants ────────────────────────────────────────────────────────────────

import { LIVE_SELL_MONTHLY_PRICE_CENTS } from "./constants";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";
import { requireWorkspaceAdminFor } from "@/lib/auth/require-workspace-role";

// ─── types ────────────────────────────────────────────────────────────────────

type ActionResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type LiveSellCheckoutInput = {
  prospectName: string;   // business name
  prospectFirstName: string;
  prospectEmail: string;
  prospectPhone?: string;
  previewWorkspaceId: string;  // selected client workspace
  /** Monthly price in cents (operator-configured). Defaults to $397 if absent. */
  monthlyPriceCents?: number;
  /** One-time setup fee in cents (0 = no setup fee). */
  setupFeeCents?: number;
  /** Which services are included. Defaults to all 7 if absent. */
  scopeItems?: { label: string }[];
};

export type LiveSellCheckoutResult = {
  clientSecret: string;
  stripeAccount: string;
  publishableKey: string;
  proposalId: string;
};

// ─── action: step 1 → step 2 transition ─────────────────────────────────────

export async function createLiveSellCheckoutAction(
  input: LiveSellCheckoutInput,
): Promise<ActionResult<LiveSellCheckoutResult>> {
  // EPIC 2026-10-21: authority is checked on the TARGET workspace below (requireWorkspaceAdminFor), after this action's own
  // session check; the caller's ACTIVE workspace is irrelevant to it.
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "unauthorized" };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!user) return { ok: false, error: "user_not_found" };

  // The agency org is the user's primary org (the one they log in as).
  const agencyOrgId = user.orgId;

  // The prospect workspace comes from the client: only one this operator may act
  // in (same rules as getOrgId). A foreign id is refused like a missing one —
  // otherwise a paid checkout could drive the Stripe webhook to take another
  // workspace out of preview and email its onboarding link to a chosen address.
  if (!(await userCanAccessOrg(session.user.id, input.previewWorkspaceId))) {
    return { ok: false, error: "workspace_not_found" };
  }
  await requireWorkspaceAdminFor(input.previewWorkspaceId);
  await requireWorkspaceAdminFor(agencyOrgId);

  // Find the agency's active Stripe connected account.
  const [conn] = await db
    .select({ accountId: stripeConnections.stripeAccountId })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.orgId, agencyOrgId),
        eq(stripeConnections.isActive, true),
      ),
    )
    .limit(1);

  if (!conn) {
    return { ok: false, error: "stripe_not_connected" };
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return { ok: false, error: "stripe_not_configured" };
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) {
    return { ok: false, error: "stripe_publishable_key_missing" };
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.seldonframe.com";

  // Validate + normalise pricing inputs.
  const monthlyPriceCents =
    typeof input.monthlyPriceCents === "number" && input.monthlyPriceCents > 0
      ? Math.round(input.monthlyPriceCents)
      : LIVE_SELL_MONTHLY_PRICE_CENTS;

  const setupFeeCents =
    typeof input.setupFeeCents === "number" && input.setupFeeCents >= 0
      ? Math.round(input.setupFeeCents)
      : 0;

  const defaultScopeItems = [
    { label: "Website" },
    { label: "Booking page" },
    { label: "24/7 missed-call text-back" },
    { label: "AI chatbot" },
    { label: "Google review requester" },
    { label: "Intake form" },
    { label: "CRM + deal pipeline" },
  ];

  const scopeItems =
    Array.isArray(input.scopeItems) && input.scopeItems.length > 0
      ? input.scopeItems
      : defaultScopeItems;

  // Create the proposal record (carries metadata for the webhook + activation).
  const agencyName = user.agencyProfile?.name ?? user.name;
  const agencyBrandColor = user.agencyProfile?.brand_color ?? undefined;

  const proposal = await createProposal({
    agencyOrgId,
    createdByUserId: user.id,
    prospectName: input.prospectName,
    prospectEmail: input.prospectEmail,
    prospectFirstName: input.prospectFirstName || null,
    prospectPhone: input.prospectPhone || null,
    agencyName,
    agencyBrandColor,
    monthlyPriceCents,
    setupFeeCents,
    previewWorkspaceId: input.previewWorkspaceId,
    // scopeItems: operator-configured for live-sell; proposal HTML is minimal
    // (live-sell closes in the meeting, no async review step).
    scopeItems,
    generatedHtml: `<p>Live-sell checkout for ${input.prospectName}. $${(monthlyPriceCents / 100).toFixed(0)}/mo.</p>`,
  });

  // 2026-07-10 — GMV fee is tier-scoped: 0% on agency tiers, 2% on solo.
  // Resolve the SELLING (agency) org's subscription tier via the existing
  // billing subscription helper (same one hasFeature/getOrgFeatures use).
  const sellerSubscription = await getOrgSubscription(agencyOrgId);
  const sellerTier = normalizeTierId(sellerSubscription.tier ?? null);

  // Build standard checkout params, then adapt for Embedded Checkout
  // by replacing success_url/cancel_url with return_url and adding ui_mode.
  const baseParams = buildCheckoutSessionParams({
    proposalId: proposal.id,
    previewWorkspaceId: input.previewWorkspaceId,
    prospectEmail: input.prospectEmail,
    prospectName: input.prospectName,
    monthlyPriceCents,
    setupFeeCents,
    signedToken: proposal.signedToken,
    baseUrl,
    sellerTier,
  });

  // Remove hosted-mode-only fields; add embedded-mode fields.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { success_url, cancel_url, ...restParams } = baseParams as typeof baseParams & {
    success_url?: string;
    cancel_url?: string;
  };

  const embeddedParams = {
    ...restParams,
    ui_mode: "embedded" as const,
    return_url: `${baseUrl}/start/return?session_id={CHECKOUT_SESSION_ID}`,
    billing_address_collection: "required" as const,
  };

  // Create the session on the agency's connected account (direct charge).
  const checkoutSession = await stripe.checkout.sessions.create(
    embeddedParams,
    { stripeAccount: conn.accountId },
  );

  if (!checkoutSession.client_secret) {
    logEvent("live_sell_checkout_no_client_secret", {
      proposalId: proposal.id,
      sessionId: checkoutSession.id,
    });
    return { ok: false, error: "checkout_session_missing_client_secret" };
  }

  // Persist the session id on the proposal so the webhook can fall back to
  // stripeCheckoutSessionId lookup if metadata doesn't surface (mirroring
  // the pattern in app/p/[token]/accept/route.ts).
  await db
    .update(proposals)
    .set({ stripeCheckoutSessionId: checkoutSession.id, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  logEvent("live_sell_checkout_session_created", {
    proposalId: proposal.id,
    sessionId: checkoutSession.id,
    agencyOrgId,
    previewWorkspaceId: input.previewWorkspaceId,
  });

  return {
    ok: true,
    value: {
      clientSecret: checkoutSession.client_secret,
      stripeAccount: conn.accountId,
      publishableKey,
      proposalId: proposal.id,
    },
  };
}

// ─── action: return page — apply mini onboarding form ────────────────────────

export async function applyOnboardingMiniFormAction(input: {
  orgId: string;
  services_text?: string;
  hours_text?: string;
  google_reviews_url?: string;
}): Promise<ActionResult<void>> {
  // EPIC 2026-10-21: authority is checked on the TARGET workspace below (requireWorkspaceAdminFor), after this action's own
  // session check; the caller's ACTIVE workspace is irrelevant to it.
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "unauthorized" };
  // The orgId comes from the client: only a workspace this user may act in.
  if (!(await userCanAccessOrg(session.user.id, input.orgId))) return { ok: false, error: "org_not_found" };
  await requireWorkspaceAdminFor(input.orgId);

  try {
    // buildChangePlan + applyChangePlan no-op on missing keys, so passing
    // only the 4 high-value fields is safe — it won't zero out anything else.
    const plan = buildChangePlan({
      services_text: input.services_text ?? "",
      hours_text: input.hours_text ?? "",
      google_reviews_url: input.google_reviews_url ?? "",
    });

    await applyChangePlan(input.orgId, plan);
    return { ok: true, value: undefined };
  } catch (err) {
    logEvent("live_sell_onboarding_mini_form_failed", {
      orgId: input.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : "apply_change_plan_failed",
    };
  }
}

