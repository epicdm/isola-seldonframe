import { NextRequest, NextResponse } from "next/server";
import { establishPortalMagicSession } from "@/lib/portal/auth";
import { tenantRedirectOrigin } from "@/lib/http/tenant-redirect-origin";
import { safeInternalRedirect } from "@/lib/http/redirect-target";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orgSlug: string }> }
) {
  const { orgSlug } = await context.params;
  const origin = await tenantRedirectOrigin(request, orgSlug);
  const token = request.nextUrl.searchParams.get("token")?.trim() || "";
  const redirectTo = request.nextUrl.searchParams.get("redirect");

  if (!token) {
    return NextResponse.redirect(new URL(`/customer/${orgSlug}/login?error=missing_magic_link`, origin));
  }

  try {
    const result = await establishPortalMagicSession({
      orgSlug,
      token,
      redirectTo,
    });

    return NextResponse.redirect(new URL(safeInternalRedirect(result.redirectTo, `/customer/${orgSlug}?onboarding=1`), origin));
  } catch {
    return NextResponse.redirect(new URL(`/customer/${orgSlug}/login?error=invalid_magic_link`, origin));
  }
}
