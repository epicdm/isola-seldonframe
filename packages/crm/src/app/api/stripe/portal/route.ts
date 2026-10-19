import { NextResponse } from "next/server";
import Stripe from "stripe";
import { auth } from "@/auth";
import { getOrgId } from "@/lib/auth/helpers";
import { getOrgSubscription } from "@/lib/billing/subscription";
import { isWorkspaceOwnerLike } from "@/lib/workspace/workspace-owner";

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  return new Stripe(secretKey, {
    apiVersion: "2025-08-27.basil",
  });
}

function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export async function POST() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 500 });
  }

  const stripe = getStripeClient();

  if (!stripe) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 500 });
  }

  const orgId = await getOrgId();
  const subscriptionOrgId = orgId ?? session.user.orgId ?? null;
  const subscription = await getOrgSubscription(subscriptionOrgId);
  const customerId = subscription.stripeCustomerId ?? null;

  if (!customerId) {
    return NextResponse.json({ error: "No subscription" }, { status: 400 });
  }

  // 2026-10-19 — the workspace's billing portal is owner-level; an invited
  // admin/member is refused (lib/workspace/workspace-owner.ts).
  if (!subscriptionOrgId || !(await isWorkspaceOwnerLike(subscriptionOrgId, session.user.id))) {
    return NextResponse.json({ error: "Only the workspace owner can manage billing." }, { status: 403 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getAppUrl()}/settings/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
