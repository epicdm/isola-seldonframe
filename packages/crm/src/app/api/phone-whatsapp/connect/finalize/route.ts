// POST /api/phone-whatsapp/connect/finalize — completes a connection. The browser sends the one-time code and its HINTS (waba, phone) plus
// the nonce; the server exchanges the code, makes Meta confirm every claim, and only then binds the number to the SESSION's workspace.
import { connectJson, guardConnect } from "@/lib/phone-whatsapp/connect/route-guard";
import { finalizeConnect } from "@/lib/phone-whatsapp/connect/finalize";
import { makeFinalizeDeps } from "@/lib/phone-whatsapp/connect/server-wiring";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  bad_input: 400, attempt_invalid: 409, attempt_superseded: 409, already_bound: 409, platform_unverified: 422,
  token_invalid: 422, wrong_app: 422, missing_scope: 422, waba_not_authorised: 422, phone_not_on_waba: 422,
  coexistence_not_supported_here: 422, not_cloud_api: 422, protected_asset: 422, epic_owned_waba: 422,
  meta_unavailable: 502, register_failed: 502, persist_failed: 500, forbidden: 403, needs_review: 409,
};

export async function POST(req: Request) {
  const g = await guardConnect(req);
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  let r;
  try {
    r = await finalizeConnect(
      { orgId: g.orgId, userId: g.userId, nonce: body?.nonce, code: body?.code, wabaId: body?.wabaId, phoneNumberId: body?.phoneNumberId },
      makeFinalizeDeps(g.cfg),
    );
  } catch (e) {
    // Log the failure CLASS only: database errors carry the failed statement and its parameters, which can include the one-time code's derivatives.
    console.error("[phone-connect] finalize failed:", e instanceof Error ? e.name : "unknown");
    return connectJson(500, { ok: false, code: "persist_failed", message: "The connection could not be completed. Nothing was reported as connected; try again." });
  }
  if (!r.ok) return connectJson(STATUS[r.code] ?? 500, { ok: false, code: r.code, message: r.message });
  return connectJson(200, { ok: true, phoneNumberId: r.phoneNumberId, displayNumber: r.displayNumber, resumed: r.resumed });
}
