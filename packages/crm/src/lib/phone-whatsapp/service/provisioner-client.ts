// SeldonFrame's client for the EPIC-side provisioner (a separate service). Implements the Provisioner port from attach.ts. Requests are HMAC-signed with a shared
// secret; the response is never trusted for ownership (the provisioner asks SeldonFrame to confirm the binding itself). This client holds NO voice-platform
// credential and has no method for billing, update or delete.
import { createHmac } from "node:crypto";

import type { Provisioner } from "./attach";

export function signBody(secret: string, ts: number, body: string) {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export class ProvisionerHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(`provisioner ${status} ${code}`); this.name = "ProvisionerHttpError"; }
}

export function makeProvisionerClient(opts: { baseUrl: string; secret: string; workspaceId: string; phoneNumberId: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Provisioner & { number?: string } {
  const f = opts.fetchImpl ?? fetch;
  const call = async <T,>(route: string, body: Record<string, unknown>): Promise<T> => {
    const raw = JSON.stringify({ ...body, workspaceId: opts.workspaceId, phoneNumberId: opts.phoneNumberId });
    const ts = Date.now();
    const res = await f(`${opts.baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-prov-ts": String(ts), "x-prov-sig": signBody(opts.secret, ts, raw) }, body: raw, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    const j = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new ProvisionerHttpError(res.status, j.error ?? "error");
    return j;
  };
  return {
    ensureServiceAccount: (a) => call("/v1/ensure-service-account", { key: a.key }),
    ensureDid: (a) => call("/v1/ensure-did", { key: a.key, accountRef: a.accountRef, number: (a as unknown as { number: string }).number }),
    ensureDestination: (a) => call("/v1/ensure-destination", { key: a.key, didRef: a.didRef, target: "trunk" in a.target ? `${a.target.trunk}/${a.target.ext}` : `agent:${a.target.agentRef}` }),
    readBack: (a) => call("/v1/read-back", { key: `rb:${a.didRef}`, didRef: a.didRef }),
  };
}
