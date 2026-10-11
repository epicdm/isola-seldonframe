// EPIC 2026-10-11 - R1 slice S-c: redemption of a WhatsApp portal link (lib/personal-line/portal-link.ts).
// GET only shows an interstitial (link previews / prefetchers must not consume a single-use link). POST consumes it
// atomically, sets the same signed portal session cookie as the emailed-code flow, and lands on the portal Home.
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { drizzlePortalLinkStore, redeemWaLink, waLinkInterstitial } from "@/lib/personal-line/portal-link";
import { PORTAL_SESSION_COOKIE, signPortalSession } from "@/lib/portal/session";
import { tenantRedirectOrigin } from "@/lib/http/tenant-redirect-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function GET(request: NextRequest, context: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await context.params;
  const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!TOKEN_RE.test(token)) {
    const origin = await tenantRedirectOrigin(request, orgSlug);
    return NextResponse.redirect(new URL(`/customer/${orgSlug}/login?error=invalid_magic_link`, origin), { headers: NO_STORE });
  }
  return new NextResponse(waLinkInterstitial(orgSlug, token), { status: 200, headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await context.params;
  const origin = await tenantRedirectOrigin(request, orgSlug);
  const fail = () => NextResponse.redirect(new URL(`/customer/${orgSlug}/login?error=invalid_magic_link`, origin), { status: 303, headers: NO_STORE });
  try {
    const form = await request.formData().catch(() => null);
    const token = String(form?.get("token") ?? "").trim();
    const hit = await redeemWaLink(orgSlug, token, await drizzlePortalLinkStore());
    if (!hit) return fail();
    const session = signPortalSession({ orgId: hit.orgId, contactId: hit.contactId, email: hit.email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    const response = NextResponse.redirect(new URL(`/customer/${orgSlug}`, origin), { status: 303, headers: NO_STORE });
    response.cookies.set({ name: PORTAL_SESSION_COOKIE, value: session, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 24 * 60 * 60 });
    // Same bookkeeping as the emailed-code flow: last-login stamp + the native portal.login event.
    const { db } = await import("@/db");
    const { contacts } = await import("@/db/schema");
    const { emitSeldonEvent } = await import("@/lib/events/bus");
    await db.update(contacts).set({ portalLastLoginAt: new Date() }).where(eq(contacts.id, hit.contactId));
    await emitSeldonEvent("portal.login", { contactId: hit.contactId }, { orgId: hit.orgId });
    return response;
  } catch (err) {
    console.error(`[pl-portal-link] redeem_error: ${err instanceof Error ? err.name : "error"}`);
    return fail();
  }
}
