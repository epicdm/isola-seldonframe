// POST /api/phone-whatsapp/connect/account-events — service-to-service: the BFF's WABA guard forwards Meta account_update events for
// non-EPIC WABAs here (Meta never sends account_update to a callback override). HMAC-signed exactly like the calls forward
// (x-prov-ts / x-prov-sig, PHONE_CALL_EVENT_SECRET). The connections are found from OUR records of the WABA, never from the body.
import { NextResponse } from "next/server";

import { parseLifecycleEvent, planLifecycle } from "@/lib/phone-whatsapp/connect/lifecycle";
import { auditConnect, findConnectionsByWaba, setLifecycleStatus } from "@/lib/phone-whatsapp/connect/server-wiring";
import { verifySigned } from "@/lib/phone-whatsapp/service/server-wiring";

export const dynamic = "force-dynamic";

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySigned(req, raw, "PHONE_CALL_EVENT_SECRET")) return json(401, { ok: false, code: "bad_signature" });
  let b: unknown; try { b = JSON.parse(raw); } catch { return json(400, { ok: false, code: "bad_json" }); }
  const ev = parseLifecycleEvent(b);
  if (!ev) return json(400, { ok: false, code: "bad_input" });
  try {
    const conns = await findConnectionsByWaba(ev.wabaId);
    const plan = planLifecycle(ev, conns);
    let applied = 0;
    for (const t of plan) {
      const ok = await setLifecycleStatus({ ...t, at: ev.at });
      if (ok) applied++;
      auditConnect(t.orgId, "lifecycle", { event: ev.event, reason: ev.reason, phoneNumberId: t.phoneNumberId, from: t.from, to: t.to, applied: ok });
    }
    for (const c of conns) if (!plan.some((t) => t.orgId === c.orgId && t.phoneNumberId === c.phoneNumberId)) {
      auditConnect(c.orgId, "lifecycle_noop", { event: ev.event, reason: ev.reason, phoneNumberId: c.phoneNumberId, status: c.status });
    }
    console.log(`[phone-connect] account_update ${ev.event} waba=${ev.wabaId} connections=${conns.length} applied=${applied}`);
    return json(200, { ok: true, connections: conns.length, applied });
  } catch (e) {
    console.error("[phone-connect] account-events failed:", e instanceof Error ? e.name : "unknown");
    return json(500, { ok: false, code: "error" }); // the BFF retries once with the identical body; transitions are compare-and-set
  }
}
