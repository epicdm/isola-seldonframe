// GET /api/internal/phone-whatsapp/binding?workspaceId&phoneNumberId — signed; lets the provisioner confirm that a workspace really holds an ACTIVE connection to a number
// before it touches anything. The provisioner does not take the caller's word for it.
import { claimantsOf, connectionStatusOf } from "@/lib/phone-whatsapp/service/stores";
import { serviceJson, verifySigned } from "@/lib/phone-whatsapp/service/server-wiring";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!verifySigned(req, url.search.replace(/^\?/, ""), "PHONE_PROVISIONER_SECRET")) return serviceJson(401, { bound: false });
  const ws = url.searchParams.get("workspaceId") ?? ""; const phone = url.searchParams.get("phoneNumberId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(ws) || !/^\d{5,20}$/.test(phone)) return serviceJson(400, { bound: false });
  const claimants = await claimantsOf(phone);
  const bound = claimants.length === 1 && claimants[0] === ws && (await connectionStatusOf(ws, phone)) === "active";
  return serviceJson(200, { bound });
}
