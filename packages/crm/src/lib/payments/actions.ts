"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { buildStripeConnectUrl, createCheckoutSession } from "@seldonframe/payments";
import { db } from "@/db";
import { activities, bookings, paymentRecords, stripeConnections, users } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { emitSeldonEvent } from "@/lib/events/bus";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";
import {
  STRIPE_CONNECT_STATE_COOKIE,
  STRIPE_CONNECT_STATE_MAX_AGE_SECONDS,
  newStripeConnectNonce,
  resolveStripeConnectStateSecret,
  signStripeConnectState,
} from "@/lib/payments/stripe-connect-state";

function getAppBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export async function startStripeConnectAction() {
  await requireWorkspaceAdmin();
  const user = await getCurrentUser();
  const orgId = await getOrgId();

  if (!user?.id || !orgId) {
    throw new Error("Unauthorized");
  }

  // The OAuth `state` is an opaque nonce; the workspace and user it was minted for
  // travel only in the signed, httpOnly cookie that the callback verifies.
  const secret = resolveStripeConnectStateSecret();
  if (!secret) {
    throw new Error("Stripe Connect state secret is not configured");
  }
  // Stripe returns to the callback on NEXT_PUBLIC_APP_URL's host, and the state cookie is
  // host-only, so the flow can only complete when it starts on that host. Started anywhere
  // else, send the user to the same page on the callback host instead of minting a state
  // that could never be honoured.
  const callbackOrigin = new URL(getAppBaseUrl());
  const requestHeaders = await headers();
  const requestHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host") || "";
  // Parse the request host with the callback's scheme so a default port (":443") compares equal.
  const isCallbackHost = (raw: string) => {
    try {
      return new URL(`${callbackOrigin.protocol}//${raw}`).host === callbackOrigin.host;
    } catch {
      return false;
    }
  };
  if (requestHost && !isCallbackHost(requestHost)) {
    redirect(`${callbackOrigin.origin}/settings/payments`);
  }
  const state = newStripeConnectNonce();
  const signedState = signStripeConnectState(
    { v: 1, nonce: state, orgId, userId: user.id, exp: Date.now() + STRIPE_CONNECT_STATE_MAX_AGE_SECONDS * 1000 },
    secret,
  );
  const redirectUri = `${getAppBaseUrl()}/api/stripe/connect/callback`;
  const connectUrl = buildStripeConnectUrl({ state, redirectUri });

  const cookieStore = await cookies();
  cookieStore.set(STRIPE_CONNECT_STATE_COOKIE, signedState, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STRIPE_CONNECT_STATE_MAX_AGE_SECONDS,
  });

  redirect(connectUrl);
}

export async function getStripeConnectionStatus() {
  await requireWorkspaceAdmin();
  const orgId = await getOrgId();

  if (!orgId) {
    return null;
  }

  const [row] = await db
    .select({
      stripeAccountId: stripeConnections.stripeAccountId,
      connectedAt: stripeConnections.connectedAt,
      isActive: stripeConnections.isActive,
    })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.orgId, orgId), eq(stripeConnections.isActive, true)))
    .orderBy(desc(stripeConnections.connectedAt))
    .limit(1);

  return row ?? null;
}

export async function getContactRevenue(contactId: string) {
  const orgId = await getOrgId();

  if (!orgId) {
    return "0.00";
  }

  const [row] = await db
    .select({
      value: sql<string>`coalesce(sum(${paymentRecords.amount}), '0')`,
    })
    .from(paymentRecords)
    .where(and(eq(paymentRecords.orgId, orgId), eq(paymentRecords.contactId, contactId), eq(paymentRecords.status, "completed")));

  return row?.value ?? "0.00";
}
