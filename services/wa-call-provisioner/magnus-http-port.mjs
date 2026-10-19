// The provisioner's upstream port over HTTP, here speaking to the SIMULATED voice platform. A production adapter for the real platform is a separate,
// unapproved step (its credential containment is an open production gate); this file must not be pointed at a real system.
export function httpPort(baseUrl, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const post = async (path, body) => {
    const res = await fetchImpl(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error ?? `upstream ${res.status}`); e.status = res.status; throw e; }
    return j;
  };
  return {
    async findAccount(workspaceId) { const r = await post("/api/account/find", { tag: workspaceId }); return r.account ? { ref: r.account.ref } : null; },
    async createAccount(workspaceId) { const r = await post("/api/account/create", { tag: workspaceId }); return { ref: r.account.ref }; },
    async findDid(number) { const r = await post("/api/did/find", { number }); return r.did ? { ref: r.did.ref, accountRef: r.did.accountRef } : null; },
    async getDid(ref) { const r = await post("/api/did/get", { ref }); return r.did ? { ref: r.did.ref, active: r.did.active } : null; },
    async createDid({ number, accountRef, tag }) { const r = await post("/api/did/create", { number, accountRef, tag }); return { ref: r.did.ref }; },
    async listDestinations(didRef) { const r = await post("/api/dest/list", { didRef }); return r.rows.map((x) => ({ ref: x.ref, target: x.target, active: x.active })); },
    async createDestination({ didRef, target }) { const r = await post("/api/dest/create", { didRef, target }); return { ref: r.row.ref }; },
  };
}
