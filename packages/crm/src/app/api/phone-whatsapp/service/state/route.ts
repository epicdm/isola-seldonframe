// GET /api/phone-whatsapp/service/state?phoneNumberId=… — the four separate states for one of THIS workspace's numbers (any member may read).
import { serviceView } from "@/lib/phone-whatsapp/service/orchestrate";
import { guardService, serviceJson } from "@/lib/phone-whatsapp/service/server-wiring";
import { activeLinesOf } from "@/lib/phone-whatsapp/service/stores";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guardService(req, false);
  if (g instanceof Response) return g;
  const phone = new URL(req.url).searchParams.get("phoneNumberId") ?? "";
  if (!/^\d{5,20}$/.test(phone) || !(await activeLinesOf(g.orgId)).some((l) => l.phoneNumberId === phone)) return serviceJson(404, { ok: false, code: "not_found" });
  try { return serviceJson(200, { ok: true, view: await serviceView(g.orgId, phone, g.deps) }); }
  catch (e) { console.error("[phone-service] state failed:", e instanceof Error ? e.name : "unknown"); return serviceJson(500, { ok: false, code: "failed" }); }
}
