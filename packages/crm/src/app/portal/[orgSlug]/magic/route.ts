// v1.20.0 — operator portal magic-link verification
//
// Consumes the magic-link token, swaps it for a session cookie,
// redirects to the operator dashboard. Mirrors the customer-portal
// magic verification at /customer/[orgSlug]/magic but produces
// an OPERATOR session (long TTL, full workspace access) instead of
// a customer session (contact-scoped).

import { NextRequest, NextResponse } from "next/server";
import { consumeOperatorMagicLink } from "@/lib/operator-portal/auth";
import { tenantRedirectOrigin } from "@/lib/http/tenant-redirect-origin";
import { safeInternalRedirect } from "@/lib/http/redirect-target";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orgSlug: string }> },
) {
  const { orgSlug } = await context.params;
  const origin = await tenantRedirectOrigin(request, orgSlug);
  const token = request.nextUrl.searchParams.get("token")?.trim() || "";
  const redirectTo = safeInternalRedirect(request.nextUrl.searchParams.get("redirect"), `/portal/${orgSlug}`);

  if (!token) {
    return NextResponse.redirect(
      new URL(`/portal/${orgSlug}/login?error=missing_magic_link`, origin),
    );
  }

  const result = await consumeOperatorMagicLink({ orgSlug, token });
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(`/portal/${orgSlug}/login?error=invalid_magic_link`, origin),
    );
  }

  // v1 PWA — land on the mobile shell (Today), not the dense desktop
  // CRM. The installed contractor app's start_url is /portal/<slug>/,
  // so after sign-in the operator continues straight into the app they
  // launched. An explicit ?redirect= (relative) still wins.
  return NextResponse.redirect(new URL(redirectTo, origin));
}
