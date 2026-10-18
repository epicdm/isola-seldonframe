// POST /api/phone-whatsapp/service/accept { phoneNumberId, twoWayAudio } — an owner/admin states whether the acceptance call had two-way audio. The statement is stored
// only if the server can see the evidence it rests on (routing verified for the CURRENT destination + a Meta call event + a matching answered call record).
import { recordAcceptance } from "@/lib/phone-whatsapp/service/orchestrate";
import { guardService, serviceJson } from "@/lib/phone-whatsapp/service/server-wiring";
import { activeLinesOf } from "@/lib/phone-whatsapp/service/stores";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guardService(req, true);
  if (g instanceof Response) return g;
  const b = (await req.json().catch(() => null)) as { phoneNumberId?: unknown; twoWayAudio?: unknown } | null;
  const phone = typeof b?.phoneNumberId === "string" ? b.phoneNumberId : "";
  if (!/^\d{5,20}$/.test(phone) || typeof b?.twoWayAudio !== "boolean" || !(await activeLinesOf(g.orgId)).some((l) => l.phoneNumberId === phone)) return serviceJson(404, { ok: false, code: "not_found" });
  try {
    const r = await recordAcceptance(g.orgId, phone, { userId: g.userId, role: g.role }, b.twoWayAudio, g.deps);
    return r.ok ? serviceJson(200, { ok: true, state: r.state }) : serviceJson(r.code === "evidence_missing" ? 409 : r.code === "forbidden" ? 403 : 409, { ok: false, code: r.code, missing: r.missing });
  } catch (e) { console.error("[phone-service] accept failed:", e instanceof Error ? e.name : "unknown"); return serviceJson(500, { ok: false, code: "failed" }); }
}
