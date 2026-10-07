import { NextResponse } from "next/server";
import { completeStripeConnectFromCode } from "@/lib/payments/actions";
import { canonicalAppOrigin } from "@/lib/http/app-hosts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const appOrigin = canonicalAppOrigin();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(new URL("/settings/payments?error=connect_callback", appOrigin));
  }

  try {
    await completeStripeConnectFromCode({ code, state });
    return NextResponse.redirect(new URL("/settings/payments?connected=1", appOrigin));
  } catch {
    return NextResponse.redirect(new URL("/settings/payments?error=connect_failed", appOrigin));
  }
}
