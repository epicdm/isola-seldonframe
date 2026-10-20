// EPIC 2026-10-20 — platform-admin management path for a tenant workspace's ownership (Port
// dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20): the internal (payment-off) entitlement, the audited ownership
// transfer and its state-checked rollback. All logic and every safeguard live in lib/workspace/transfer-ownership.ts; this route only
// authenticates the platform admin.
//
// Authority is the signed-in NextAuth user whose email is in SF_SUPERADMIN_EMAILS. Operator-portal sessions, agency support sessions
// and workspace bearer tokens are not NextAuth sessions and are refused here. Same-origin POST only (the public-pilot kill switch's
// CSRF guard).

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isEmailInAllowlist, parseAdminAllowlist } from "@/lib/operator-portal/authorization";
import {
  rollbackWorkspaceOwnershipTransfer,
  setInternalWorkspaceEntitlement,
  transferWorkspaceOwnership,
} from "@/lib/workspace/transfer-ownership";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  const hostHeader = (request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("host") ?? "").trim().toLowerCase();
  return Boolean(hostHeader) && originHost === hostHeader;
}

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return json({ error: "same_origin_required" }, 403);
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email ?? null;
  if (!userId || !email) return json({ error: "unauthorized" }, 401);
  if (!isEmailInAllowlist(email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) return json({ error: "forbidden" }, 403);

  const { id: orgId } = await context.params;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid_json" }, 400); }
  const actor = { userId, email };
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");

  switch (body.action) {
    case "internal_entitlement": {
      const r = await setInternalWorkspaceEntitlement({ orgId, tier: str("tier"), actor });
      return json(r, r.ok ? 200 : 409);
    }
    case "transfer": {
      const r = await transferWorkspaceOwnership({
        orgId,
        expectedCurrentOwnerId: str("expectedCurrentOwnerId"),
        newOwnerUserId: str("newOwnerUserId"),
        expectedTier: str("expectedTier"),
        oldOwnerHomeOrgId: str("oldOwnerHomeOrgId") || undefined,
        actor,
      });
      return json(r, r.ok ? 200 : 409);
    }
    case "rollback": {
      const r = await rollbackWorkspaceOwnershipTransfer({ orgId, transferActionId: str("transferActionId"), actor });
      return json(r, r.ok ? 200 : 409);
    }
    default:
      return json({ error: "unknown_action" }, 400);
  }
}
