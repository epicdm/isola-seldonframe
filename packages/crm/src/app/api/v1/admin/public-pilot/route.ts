import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { disablePublicPilot, readPublicPilotUsage } from "@/lib/agents/public-turn-spend";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** CSRF guard for the kill switch. Behind the ingress, `request.nextUrl.origin` is the container's own http origin, so the
 * browser's `https://<site>` Origin never matches it (found by Lane A in acceptance: the kill switch always answered 403).
 * Compare the Origin HOST with the Host the browser addressed (x-forwarded-host first, as the rest of the app does). A
 * cross-site page cannot forge either header, and the session cookie is still required. */
function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  const hostHeader = (request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("host") ?? "").trim().toLowerCase();
  return Boolean(hostHeader) && originHost === hostHeader;
}

async function authorizedWorkspace() {
  const user = await getCurrentUser();
  const orgId = await getOrgId();
  const role = await getCurrentWorkspaceRole();
  if (!user?.id || !orgId) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE }) };
  if (role !== "admin" && role !== "owner") {
    return { response: NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE }) };
  }
  return { orgId };
}

export async function GET() {
  const auth = await authorizedWorkspace();
  if ("response" in auth) return auth.response;
  const usage = await readPublicPilotUsage(auth.orgId);
  if (!usage) return NextResponse.json({ error: "pilot_readback_unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ usage }, { headers: NO_STORE });
}

/** One-way kill switch; there is intentionally no route that enables a pilot. */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "same_origin_required" }, { status: 403, headers: NO_STORE });
  }

  const auth = await authorizedWorkspace();
  if ("response" in auth) return auth.response;
  const disabled = await disablePublicPilot(auth.orgId);
  if (!disabled) return NextResponse.json({ error: "pilot_disable_unavailable" }, { status: 503, headers: NO_STORE });
  const usage = await readPublicPilotUsage(auth.orgId);
  if (!usage) return NextResponse.json({ error: "pilot_readback_unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ disabled: true, usage }, { headers: NO_STORE });
}
