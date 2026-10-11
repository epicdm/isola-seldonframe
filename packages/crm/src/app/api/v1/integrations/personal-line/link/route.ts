// EPIC 2026-10-11 — POST /api/v1/integrations/personal-line/link (subscriber account slice 2a).
//
// The Personal Line service (plsvc) tells this workspace "liteAccount <pl_account_id> belongs to the Meta-verified
// WhatsApp sender <wa_id>". This is the ONLY path that creates or attaches an external_identities row.
//
// Auth: HMAC-SHA256 over "<ts>.<raw body>" with PL_SF_EVENTS_KEY (file), ±300 s, key id header (lib/personal-line/signing.ts).
// Scope: the single workspace pinned by PL_SF_ORG_ID — the body cannot name a workspace or a contact.
// Unconfigured -> 503; unsigned / bad / old signature -> 401; bad body -> 422. Nothing is read or written before the
// signature verifies.
//
// NOT DONE HERE (next iteration, design §2): the durable event inbox (pl_event_inbox), typed pl.* events and the
// forward-only pipeline projection.
import { NextResponse } from "next/server";
import { drizzleLinkStore, linkPersonalLine, parseLinkBody } from "@/lib/personal-line/link";
import { readPlKey, verifyIngress } from "@/lib/personal-line/signing";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const orgId = process.env.PL_SF_ORG_ID?.trim() ?? "";
  const key = await readPlKey("PL_SF_EVENTS_KEY_FILE", "PL_SF_EVENTS_KEY_ID");
  if (!UUID.test(orgId) || !key) {
    console.error(`[pl-link] not_configured: ${!UUID.test(orgId) ? "PL_SF_ORG_ID " : ""}${key ? "" : "PL_SF_EVENTS_KEY_FILE/PL_SF_EVENTS_KEY_ID"}`);
    return json(503, { ok: false, error: "not_configured" });
  }
  const raw = await request.text().catch(() => null);
  if (raw === null) return json(400, { ok: false, error: "unreadable_body" });
  const check = verifyIngress(request.headers, raw, key, Math.floor(Date.now() / 1000));
  if (!check.ok) {
    console.warn(`[pl-link] refused: ${check.why}`);
    return json(401, { ok: false, error: "unauthorized" });
  }
  const input = parseLinkBody(raw);
  if (!input) return json(422, { ok: false, error: "invalid_body" });
  try {
    const result = await linkPersonalLine(orgId, input, await drizzleLinkStore());
    if (!result.ok) {
      console.error(`[pl-link] ${result.reason} wa=***${input.waId.slice(-4)}`);
      return json(409, { ok: false, error: result.reason });
    }
    console.info(`[pl-link] linked created=${result.created} wa=***${input.waId.slice(-4)}`);
    return json(200, { ok: true, contact_id: result.contactId, created: result.created });
  } catch (err) {
    console.error(`[pl-link] internal_error: ${err instanceof Error ? err.name : "error"}`);
    return json(500, { ok: false, error: "internal_error" });
  }
}
