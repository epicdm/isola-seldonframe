// POST /api/phone-whatsapp/service/call-events — service-to-service (the BFF's Meta calling webhook handler, once it exists). HMAC-signed with
// PHONE_CALL_EVENT_SECRET; the workspace is DERIVED from the number's verified binding, never taken from the body. Unbound or contested numbers are dropped.
import { ingestCallEvent } from "@/lib/phone-whatsapp/service/orchestrate";
import { makeServiceDeps, serviceJson, verifySigned } from "@/lib/phone-whatsapp/service/server-wiring";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySigned(req, raw, "PHONE_CALL_EVENT_SECRET")) return serviceJson(401, { ok: false, code: "bad_signature" });
  let b: { phoneNumberId?: unknown; callId?: unknown; at?: unknown }; try { b = JSON.parse(raw); } catch { return serviceJson(400, { ok: false, code: "bad_json" }); }
  const deps = makeServiceDeps(); if (!deps) return serviceJson(503, { ok: false, code: "unavailable" });
  if (typeof b.phoneNumberId !== "string" || !/^\d{5,20}$/.test(b.phoneNumberId) || typeof b.callId !== "string" || typeof b.at !== "string") return serviceJson(400, { ok: false, code: "bad_input" });
  const r = await ingestCallEvent(b.phoneNumberId, b.callId, b.at, deps);
  return serviceJson(r.ok ? 200 : 202, { ok: r.ok, reason: r.reason ?? null }); // a dropped event is acknowledged (no retry storms) but never stored
}
