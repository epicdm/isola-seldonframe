// GET /api/stripe/connect/callback — Stripe Connect OAuth redirect target. All decision
// logic lives in lib/payments/stripe-connect-callback.ts; this file wires the real
// session, Stripe token exchange and database write around it.
import { NextResponse, type NextRequest } from "next/server";
import { exchangeStripeConnectCode } from "@seldonframe/payments";
import { db } from "@/db";
import { stripeConnections } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { canonicalAppOrigin } from "@/lib/http/app-hosts";
import { getCallerRoleIn } from "@/lib/auth/require-workspace-role";
import { isWorkspaceAdminRole } from "@/lib/auth/workspace-role";
import { handleStripeConnectCallback } from "@/lib/payments/stripe-connect-callback";
import { STRIPE_CONNECT_STATE_COOKIE, resolveStripeConnectStateSecret } from "@/lib/payments/stripe-connect-state";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const appOrigin = canonicalAppOrigin();

  const result = await handleStripeConnectCallback(
    { code: url.searchParams.get("code"), state: url.searchParams.get("state") },
    {
      getCookie: (name) => request.cookies.get(name)?.value,
      resolveSession: async () => {
        const user = await getCurrentUser();
        const orgId = await getOrgId();
        if (!user?.id || !orgId) return null;
        // EPIC 2026-10-21 (staff-access, Codex r4-r6): the caller must STILL be owner/admin of the workspace now, at
        // completion and before the token exchange — an admin demoted to staff (or removed) after starting the flow is
        // refused (session_mismatch). The signed state then binds that workspace to the one that started it.
        if (!isWorkspaceAdminRole(await getCallerRoleIn(orgId))) return null;
        return { userId: user.id, orgId };
      },
      exchange: async (code) => {
        const secretKey = process.env.STRIPE_SECRET_KEY;
        if (!secretKey) throw new Error("Stripe secret key is not configured");
        return exchangeStripeConnectCode({ code, secretKey });
      },
      saveConnection: async ({ orgId, payload }) => {
        await db.insert(stripeConnections).values({
          orgId,
          stripeAccountId: payload.stripe_user_id,
          accessToken: payload.access_token ?? null,
          stripePublishableKey: payload.stripe_publishable_key ?? null,
          isActive: true,
          connectedAt: new Date(),
        });
      },
      authSecret: resolveStripeConnectStateSecret(),
    },
  );

  const response = NextResponse.redirect(new URL(result.redirect, appOrigin));
  if (result.clearCookie) response.cookies.delete(STRIPE_CONNECT_STATE_COOKIE);
  return response;
}
