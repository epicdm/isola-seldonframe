// EPIC 2026-10-11 — POST /api/webhooks/personal-line/[orgId]: the ONE signed Personal Line ingress (journey events).
//
// PATH DECISION: the packet planned `/api/v1/events` and the spec `/api/v1/integrations/personal-line/events`. This
// route follows the fork's own precedents instead: the inbound-webhook family (app/api/webhooks/composio, /resend,
// /stripe) and the per-workspace webhook path of openaiVoice (app/api/v1/voice/openai/webhook/[orgId]). The [orgId]
// selects WHICH workspace's key verifies the MAC; a request signed for one workspace cannot verify on another's path.
//
// Auth: HMAC-SHA256 over "<ts>.<raw body>" (X-PL-SF-Kid / -Ts / -Sig, ±300 s) with the workspace's
// "personal-line-events" secret from workspace_secrets. 503 not configured · 401 bad/old signature · 422 invalid
// event · 200 processed or duplicate (no-op) · 409 identity conflict. Processing: lib/personal-line/events.ts.
import { NextResponse } from "next/server";
import { emitSeldonEvent } from "@/lib/events/bus";
import { drizzleEventStore, handlePersonalLineWebhook } from "@/lib/personal-line/events";
import { productionConfigDeps, resolvePersonalLine } from "@/lib/personal-line/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  try {
    const r = await handlePersonalLineWebhook(request, orgId, {
      resolveEventsKey: async (id) => (await resolvePersonalLine(id, await productionConfigDeps()))?.events ?? null,
      store: drizzleEventStore,
      emit: (type, data, org) => emitSeldonEvent(type, data, { orgId: org }),
    });
    return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(`[pl-webhook] internal_error: ${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
