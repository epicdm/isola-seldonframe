// Production-shaped wiring for the service increment (server-only). Reads the env, builds the real stores and the real read-only evidence path, and the signed
// provisioner client. With no PHONE_PROVISIONER_URL the feature is unavailable (fail closed), never a silent no-op.
import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { sameOrigin } from "../connect/origin";
import { isPhoneWhatsappEnabled } from "../exposure";
import { getServiceDeps } from "../server";
import { makeProvisionerClient, signBody } from "./provisioner-client";
import { activeLinesOf, appendAcceptance, appendCallEvent, claimantsOf, connectionStatusOf, makeAgentDirectory, makeAttachLedger, readAcceptance, readCallEvents, readDestinationCatalog } from "./stores";
import type { ServiceDeps, StoredAttestation } from "./orchestrate";

export const isServiceEnabled = (orgId: string | null | undefined) => isPhoneWhatsappEnabled(orgId, process.env.PHONE_SERVICE_ENABLED_ORGS);

export function makeServiceDeps(): ServiceDeps | null {
  const baseUrl = (process.env.PHONE_PROVISIONER_URL ?? "").replace(/\/+$/, "");
  const secret = process.env.PHONE_PROVISIONER_SECRET ?? "";
  if (!baseUrl || !secret) return null;
  const base = getServiceDeps();
  return {
    now: () => new Date(),
    connectionStatus: connectionStatusOf,
    claimants: claimantsOf,
    line: async (ws, phone) => (await activeLinesOf(ws)).find((l) => l.phoneNumberId === phone) ?? null,
    catalog: readDestinationCatalog,
    agents: makeAgentDirectory(),
    ledger: makeAttachLedger(),
    evidence: async (line) => { const r = await base.provider({ wabaId: line.wabaId, phoneNumberId: line.phoneNumberId }); return r.kind === "evidence" ? r.evidence : null; },
    provisioner: (ws, phone) => makeProvisionerClient({ baseUrl, secret, workspaceId: ws, phoneNumberId: phone }),
    callEvents: readCallEvents,
    appendCallEvent,
    acceptance: readAcceptance as ServiceDeps["acceptance"],
    appendAcceptance: (ws, phone, a: StoredAttestation) => appendAcceptance(ws, phone, a),
  };
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export { json as serviceJson };

export type Guarded = { orgId: string; userId: string; role: string; deps: ServiceDeps };

/** Session-derived authority: workspace from getOrgId(), role from getCurrentWorkspaceRole(), user from the session. Writes also need same-origin and owner/admin. */
export async function guardService(req: Request, write: boolean): Promise<Guarded | NextResponse> {
  if (write && !sameOrigin(req.headers)) return json(403, { ok: false, code: "bad_origin" });
  const user = await getCurrentUser(); const orgId = await getOrgId();
  if (!user?.id || !orgId) return json(401, { ok: false, code: "unauthenticated" });
  if (!isServiceEnabled(orgId)) return json(404, { ok: false, code: "not_found" });
  const deps = makeServiceDeps();
  if (!deps) return json(503, { ok: false, code: "unavailable" });
  const role = (await getCurrentWorkspaceRole()) ?? "member";
  if (write && !["owner", "admin"].includes(role)) return json(403, { ok: false, code: "forbidden" });
  return { orgId, userId: user.id, role, deps };
}

/** Verifies an HMAC-signed service-to-service request (the provisioner's binding check, the BFF's call events). */
export function verifySigned(req: Request, rawToSign: string, secretEnv: string): boolean {
  const secret = process.env[secretEnv] ?? "";
  const ts = Number(req.headers.get("x-prov-ts")); const sig = req.headers.get("x-prov-sig") ?? "";
  if (!secret || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) return false;
  const want = signBody(secret, ts, rawToSign);
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
