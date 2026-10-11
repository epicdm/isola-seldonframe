// EPIC 2026-10-11 — POST /api/v1/integrations/personal-line/events: signed, durable, idempotent Personal Line journey
// events (design §2). Same auth as the link ingress: HMAC-SHA256 over "<ts>.<raw body>" with PL_SF_EVENTS_KEY (file),
// ±300 s, key id header; workspace pinned by PL_SF_ORG_ID. Processing: lib/personal-line/events.ts.
// 503 unconfigured · 401 any signature failure · 422 bad body/type/proof fact · 200 processed or duplicate (no-op).
import { NextResponse } from "next/server";
import { drizzleEventStore, parsePlEvent, processPlEvent } from "@/lib/personal-line/events";
import { readPlKey, verifyIngress } from "@/lib/personal-line/signing";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const orgId = process.env.PL_SF_ORG_ID?.trim() ?? "";
  const key = await readPlKey("PL_SF_EVENTS_KEY_FILE", "PL_SF_EVENTS_KEY_ID");
  if (!UUID.test(orgId) || !key) return json(503, { ok: false, error: "not_configured" });
  const raw = await request.text().catch(() => null);
  if (raw === null) return json(400, { ok: false, error: "unreadable_body" });
  const check = verifyIngress(request.headers, raw, key, Math.floor(Date.now() / 1000));
  if (!check.ok) {
    console.warn(`[pl-events] refused: ${check.why}`);
    return json(401, { ok: false, error: "unauthorized" });
  }
  const event = parsePlEvent(raw);
  if (!event) return json(422, { ok: false, error: "invalid_event" });
  try {
    const { emitSeldonEvent } = await import("@/lib/events/bus");
    const result = await processPlEvent(orgId, event, await drizzleEventStore(), (type, data, org) =>
      emitSeldonEvent(type, data, { orgId: org }));
    console.info(`[pl-events] ${event.type} ${event.eventId} -> ${result.status}`);
    if (result.status === "failed") return json(409, { ok: false, error: result.reason });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(`[pl-events] internal_error: ${err instanceof Error ? err.name : "error"}`);
    return json(500, { ok: false, error: "internal_error" });
  }
}
