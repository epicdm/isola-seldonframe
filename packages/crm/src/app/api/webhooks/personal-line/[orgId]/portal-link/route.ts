// EPIC 2026-10-11 - R1 slice S-c: POST /api/webhooks/personal-line/[orgId]/portal-link (server-to-server; plsvc only).
// Mints a one-time, 10-minute portal sign-in link for a plsvc account already linked to a contact in THIS workspace and
// returns the URL to plsvc. Contract + refusals: lib/personal-line/portal-link.ts.
import { NextResponse } from "next/server";
import { appOriginFromEnv, drizzlePortalLinkStore, handlePortalLinkRequest } from "@/lib/personal-line/portal-link";
import { productionConfigDeps, resolvePersonalLine } from "@/lib/personal-line/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  try {
    const r = await handlePortalLinkRequest(request, orgId, {
      resolveEventsKey: async (id) => (await resolvePersonalLine(id, await productionConfigDeps()))?.events ?? null,
      store: drizzlePortalLinkStore,
      appOrigin: appOriginFromEnv,
    });
    return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(`[pl-portal-link] internal_error: ${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
