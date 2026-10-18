// Standard Meta connection: the one guard both API routes call. Identity is ONLY the server session: workspace from getOrgId(), role from
// getCurrentWorkspaceRole(), user from getCurrentUser(). Nothing in the request body or query names a workspace.
import { NextResponse } from "next/server";

import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { sameOrigin } from "./origin";
import { getConnectConfig } from "./server-wiring";
import type { ConnectConfig } from "./config";

export type Guarded = { orgId: string; userId: string; cfg: Extract<ConnectConfig, { ok: true }> };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function guardConnect(req: Request): Promise<Guarded | NextResponse> {
  if (!sameOrigin(req.headers)) return json(403, { ok: false, code: "bad_origin" });
  const user = await getCurrentUser();
  const orgId = await getOrgId();
  if (!user?.id || !orgId) return json(401, { ok: false, code: "unauthenticated" });
  const cfg = getConnectConfig(orgId);
  // Disabled looks exactly like "no such route" to a workspace that is not enabled.
  if (!cfg.ok) return json(cfg.reason === "disabled" ? 404 : 503, { ok: false, code: cfg.reason === "disabled" ? "not_found" : "unavailable" });
  const role = await getCurrentWorkspaceRole();
  if (role !== "owner" && role !== "admin") return json(403, { ok: false, code: "forbidden" });
  return { orgId, userId: user.id, cfg };
}

export { json as connectJson };
