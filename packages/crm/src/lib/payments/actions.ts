"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { buildStripeConnectUrl, createCheckoutSession } from "@seldonframe/payments";
import { db } from "@/db";
import { activities, bookings, paymentRecords, stripeConnections, users } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { emitSeldonEvent } from "@/lib/events/bus";
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

export async function createBookingCheckoutSession(params: {
  orgId: string;
  bookingId: string;
  contactId: string | null;
  customerEmail: string;
  amount: number;
  currency?: string;
  successPath?: string;
  cancelPath?: string;
}) {
  const successUrl = `${getAppBaseUrl()}${params.successPath || `/book/success?bookingId=${params.bookingId}`}`;
  const cancelUrl = `${getAppBaseUrl()}${params.cancelPath || `/book/cancel?bookingId=${params.bookingId}`}`;
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }

  // Connect Standard: look up the workspace's connected Stripe account
  // and route the charge there. Without this the checkout session is
  // created on SeldonFrame's platform account and the SMB never sees
  // the funds — the pre-Phase-5 bug the audit surfaced.
  const [connection] = await db
    .select({ stripeAccountId: stripeConnections.stripeAccountId })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.orgId, params.orgId), eq(stripeConnections.isActive, true)))
    .orderBy(desc(stripeConnections.connectedAt))
    .limit(1);

  if (!connection?.stripeAccountId) {
    throw new Error("Stripe Connect account is not configured for this workspace");
  }

  const session = await createCheckoutSession({
    orgId: params.orgId,
    contactId: params.contactId,
    amount: params.amount,
    currency: params.currency ?? "USD",
    sourceBlock: "booking",
    sourceId: params.bookingId,
    successUrl,
    cancelUrl,
    customerEmail: params.customerEmail,
    metadata: {
      bookingId: params.bookingId,
      stripeAccountId: connection.stripeAccountId,
    },
    stripeAccount: connection.stripeAccountId,
  });

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
  };
}

export async function handleStripeCheckoutCompleted(session: {
  id: string;
  metadata?: Record<string, string> | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | null;
}) {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const orgId = metadata.orgId;
  const bookingId = metadata.bookingId;
  const contactId = metadata.contactId || null;

  if (!orgId || !bookingId) {
    return;
  }

  const amount = Number((session.amount_total ?? 0) / 100);
  const currency = (session.currency ?? "usd").toUpperCase();
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;

  if (paymentIntentId) {
    const [existingPayment] = await db
      .select({ id: paymentRecords.id })
      .from(paymentRecords)
      .where(eq(paymentRecords.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (existingPayment) {
      return;
    }
  }

  const [booking] = await db
    .select({
      id: bookings.id,
      contactId: bookings.contactId,
      startsAt: bookings.startsAt,
      title: bookings.title,
    })
    .from(bookings)
    .where(and(eq(bookings.orgId, orgId), eq(bookings.id, bookingId)))
    .limit(1);

  await db
    .update(bookings)
    .set({
      status: "scheduled",
      updatedAt: new Date(),
      metadata: {
        paymentStatus: "paid",
        checkoutSessionId: session.id,
      },
    })
    .where(and(eq(bookings.orgId, orgId), eq(bookings.id, bookingId)));

  await db.insert(paymentRecords).values({
    orgId,
    contactId: contactId || booking?.contactId || null,
    bookingId,
    stripePaymentIntentId: paymentIntentId,
    stripeAccountId: metadata.stripeAccountId ?? null,
    amount: amount.toFixed(2),
    currency,
    status: "completed",
    sourceBlock: "booking",
    sourceId: bookingId,
    metadata: {
      checkoutSessionId: session.id,
    },
  });

  const resolvedContactId = contactId || booking?.contactId || null;

  if (resolvedContactId) {
    await emitSeldonEvent("booking.created", {
      appointmentId: bookingId,
      contactId: resolvedContactId,
    }, { orgId: orgId });

    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);

    if (owner?.id) {
      await db.insert(activities).values({
        orgId,
        userId: owner.id,
        contactId: resolvedContactId,
        type: "payment",
        subject: `Payment received for ${booking?.title || "booking"}`,
        body: `Amount: ${amount.toFixed(2)} ${currency}`,
        metadata: {
          bookingId,
          checkoutSessionId: session.id,
        },
        scheduledAt: booking?.startsAt ?? null,
      });
    }

    await emitSeldonEvent("payment.completed", {
      contactId: resolvedContactId,
      amount,
      currency,
      source: "booking",
    }, { orgId: orgId });
  }
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

export async function getRevenueByContactId(orgId: string, contactId: string) {
  const [row] = await db
    .select({ value: sql<string>`coalesce(sum(${paymentRecords.amount}), '0')` })
    .from(paymentRecords)
    .where(and(eq(paymentRecords.orgId, orgId), eq(paymentRecords.contactId, contactId), eq(paymentRecords.status, "completed")));

  return row?.value ?? "0.00";
}
