// POST /api/phone-whatsapp/service/attach { phoneNumberId, destinationId } — set up the calling service for one of THIS workspace's connected numbers.
// Authority is the session (owner/admin of the active workspace); the number's display digits come from verified evidence, not from the request.
import { attach } from "@/lib/phone-whatsapp/service/orchestrate";
import { guardService, serviceJson } from "@/lib/phone-whatsapp/service/server-wiring";
import { activeLinesOf } from "@/lib/phone-whatsapp/service/stores";

export const dynamic = "force-dynamic";
const STATUS: Record<string, number> = { bad_input: 400, not_connected: 409, number_not_yours: 403, destination_not_allowed: 403, destination_change_requires_explicit_action: 409, attach_in_progress: 409, retry_pending: 503, step_failed: 502, needs_review: 409 };

export async function POST(req: Request) {
  const g = await guardService(req, true);
  if (g instanceof Response) return g;
  const b = (await req.json().catch(() => null)) as { phoneNumberId?: unknown; destinationId?: unknown } | null;
  const phone = typeof b?.phoneNumberId === "string" ? b.phoneNumberId : ""; const dest = typeof b?.destinationId === "string" ? b.destinationId : "";
  if (!/^\d{5,20}$/.test(phone) || !dest || !(await activeLinesOf(g.orgId)).some((l) => l.phoneNumberId === phone)) return serviceJson(404, { ok: false, code: "not_found" });
  try {
    const r = await attach(g.orgId, phone, dest, g.deps);
    if (r.ok) return serviceJson(200, { ok: true, resumed: r.resumed });
    return serviceJson(STATUS[r.code] ?? 500, { ok: false, code: r.code, step: r.step ?? null, retriable: r.retriable, message: r.message });
  } catch (e) { console.error("[phone-service] attach failed:", e instanceof Error ? e.name : "unknown"); return serviceJson(500, { ok: false, code: "failed", retriable: true, message: "Setup could not be completed. Nothing was reported as set up; try again." }); }
}
