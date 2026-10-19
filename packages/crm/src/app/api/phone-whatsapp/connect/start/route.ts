// POST /api/phone-whatsapp/connect/start — records the customer's consent and mints a single-use, session-bound connection attempt.
// Returns what the browser launcher needs (app id, login configuration id, nonce). Never returns a secret.
import { connectJson, guardConnect } from "@/lib/phone-whatsapp/connect/route-guard";
import { startConnect } from "@/lib/phone-whatsapp/connect/finalize";
import { loadCoexConfig } from "@/lib/phone-whatsapp/connect/coexistence-config";
import { makeFinalizeDeps } from "@/lib/phone-whatsapp/connect/server-wiring";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guardConnect(req);
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => null)) as { consent?: unknown } | null;
  let r;
  try {
    r = await startConnect({ orgId: g.orgId, userId: g.userId, consentAccepted: body?.consent === true }, makeFinalizeDeps(g.cfg));
  } catch (e) {
    console.error("[phone-connect] start failed:", e instanceof Error ? e.name : "unknown");
    return connectJson(500, { ok: false, code: "persist_failed" });
  }
  if (!r.ok) return connectJson(r.code === "forbidden" ? 400 : 500, { ok: false, code: r.code === "forbidden" ? "consent_required" : "persist_failed" });
  return connectJson(200, {
    ok: true,
    nonce: r.nonce,
    expiresAt: r.expiresAt,
    appId: g.cfg.appId,
    configId: g.cfg.configId,
    testMode: g.cfg.testMode,
    // Whether the WhatsApp Business app (Coexistence) option can complete here. The server still decides the mode from Meta's read.
    coexistenceAvailable: loadCoexConfig(g.orgId, process.env, g.cfg.testMode) !== null,
  });
}
