// EPIC 2026-10-21 — POST /api/webhooks/personal-line/[orgId]: the ONE signed Personal Line lifecycle ingress.
//
// Path and signature are the 2026-10-11 account slice's (isola-seldonframe#12): the inbound-webhook family
// (app/api/webhooks/composio, /resend, /stripe) with a per-workspace path like app/api/v1/voice/openai/webhook/[orgId].
// Auth: HMAC-SHA256 over "<ts>.<raw body>" (X-PL-SF-Kid / -Ts / -Sig, ±300 s) with the Docker-secret key
// (PL_LIFECYCLE_KEY_FILE). The body's `tenant` must be on the explicit allowlist (PL_LIFECYCLE_TENANT_ORGS) AND map to
// exactly the [orgId] in the path. 503 not configured · 401 bad/old signature · 422 invalid event · 403 unknown tenant /
// tenant-workspace mismatch · 200 processed or duplicate (no-op) · 409 identity conflict. Processing: lib/personal-line/lifecycle.ts.
import { NextResponse } from "next/server";
import { emitSeldonEvent } from "@/lib/events/bus";
import { moveDealToStage } from "@/lib/deals/stage-move";
import { resolveLifecycleConfig } from "@/lib/personal-line/config";
import { drizzleLifecycleStore, handlePersonalLineLifecycle } from "@/lib/personal-line/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  try {
    const r = await handlePersonalLineLifecycle(request, orgId, {
      config: () => resolveLifecycleConfig(process.env),
      store: drizzleLifecycleStore,
      emit: (type, data, org, preLoggedEventId) => emitSeldonEvent(type, data as never, { orgId: org, preLoggedEventId }),
      move: (input) => moveDealToStage(input),
    });
    return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(`[pl-lifecycle] internal_error: ${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
