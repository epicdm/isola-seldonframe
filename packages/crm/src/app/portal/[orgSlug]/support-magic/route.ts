// v1.22.0 — agency support session verify route
//
// Consumes an agency-issued operator-session token and sets the
// operator session cookie. Differs from /portal/<slug>/magic only
// in that the token MUST carry supportOriginUserId — meaning it
// originated from createAgencySupportSession + a verified
// agency-owner click (not from the regular customer-portal-style
// email magic-link).

import { NextRequest, NextResponse } from "next/server";
import { consumeAgencySupportSession } from "@/lib/operator-portal/support-session";
import { tenantRedirectOrigin } from "@/lib/http/tenant-redirect-origin";
import { safeInternalRedirect } from "@/lib/http/redirect-target";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orgSlug: string }> },
) {
  const { orgSlug } = await context.params;
  const origin = await tenantRedirectOrigin(request, orgSlug);
  const token = request.nextUrl.searchParams.get("token")?.trim() || "";

  if (!token) {
    return NextResponse.redirect(
      new URL(
        `/portal/${orgSlug}/login?error=missing_support_token`,
        origin,
      ),
    );
  }

  const result = await consumeAgencySupportSession({ orgSlug, token });
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(
        `/portal/${orgSlug}/login?error=invalid_support_session`,
        origin,
      ),
    );
  }

  return NextResponse.redirect(new URL(safeInternalRedirect(result.redirectTo, `/portal/${orgSlug}`), origin));
}
