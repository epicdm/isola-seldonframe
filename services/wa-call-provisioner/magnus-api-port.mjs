// PRODUCTION-SHAPED upstream port for MagnusBilling, using ONLY its documented HTTP API operations: `read` and `save` (create, id 0) on the `did` and
// `diddestination` modules, authenticated the documented way (Key header + Sign = HMAC-SHA512 of the url-encoded POST body, with a nonce).
// NOT EXERCISED against a real Magnus: no real key exists and none may be created under the current authority. The first live run is the verification.
// It deliberately implements no update, delete, buy or any other action, and the service account is FIXED configuration (an existing Magnus user),
// so there is no user creation either. Credential containment for the key this port needs is an UNRESOLVED production gate.
import { createHmac } from "node:crypto";

// PHP-compatible form encoding (http_build_query semantics: RFC1738-style, space as '+').
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const form = (obj) => Object.entries(obj).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
// Catalog form "<trunk>/<ext>" <-> platform form "PJSIP/<ext>@<trunk>".
export const toPlatform = (t) => { const m = /^([^/]+)\/(.+)$/.exec(t); if (!m) throw Object.assign(new Error("unsupported destination form"), { code: "bad_target" }); return `PJSIP/${m[2]}@${m[1]}`; };
export const fromPlatform = (v) => { const m = /^PJSIP\/([^@]+)@(.+)$/.exec(v ?? ""); return m ? `${m[2]}/${m[1]}` : String(v ?? ""); };

export function magnusApiPort({ baseUrl, key, secret, serviceAccount, trunk, timeoutMs = 8000, fetchImpl = fetch }) {
  if (!baseUrl || !key || !secret) throw new Error("magnus api port: missing configuration");
  if (!serviceAccount?.ref || !/^\d+$/.test(String(serviceAccount.ref))) throw new Error("magnus api port: the fixed service account (an existing Magnus user id) is required");
  let nonce = Date.now() * 1000;
  async function call(module, action, fields) {
    const body = form({ ...fields, module, action, nonce: String(++nonce) });
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/index.php/${module}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Key: key, Sign: createHmac("sha512", secret).update(body).digest("hex") },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { const e = new Error("upstream answered non-JSON"); e.status = res.status; throw e; } // never echo the body
    if (!res.ok) { const e = new Error(`upstream ${res.status}`); e.status = res.status; throw e; }
    return j;
  }
  const eq = (field, value) => JSON.stringify([{ type: "string", field, value: String(value), comparison: "eq" }]);
  const rows = (j) => (Array.isArray(j?.rows) ? j.rows : []);
  return {
    // Fixed configuration: the existing Magnus user that owns this workspace's numbers. Never created by this port.
    async findAccount(workspaceId) { return serviceAccount.workspaceId === workspaceId ? { ref: String(serviceAccount.ref) } : null; },
    async createAccount() { throw Object.assign(new Error("service account is fixed configuration; not created here"), { code: "not_supported" }); },
    async findDid(number) {
      const r = rows(await call("did", "read", { filter: eq("did", number), limit: 2 })).filter((x) => String(x.did) === String(number));
      if (r.length > 1) throw Object.assign(new Error("more than one DID row for the number"), { code: "needs_review" });
      return r[0] ? { ref: String(r[0].id), accountRef: String(r[0].id_user) } : null;
    },
    async getDid(ref) {
      const r = rows(await call("did", "read", { filter: eq("id", ref), limit: 1 }))[0];
      return r ? { ref: String(r.id), active: String(r.activated) === "1" } : null;
    },
    async createDid({ number, accountRef }) {
      const j = await call("did", "save", { id: 0, did: number, id_user: accountRef, activated: 1, reserved: 1 });
      if (j?.success !== true) throw Object.assign(new Error("did save not confirmed"), { code: "unconfirmed" });
      const again = await this.findDid(number); if (!again) throw Object.assign(new Error("did not visible after save"), { code: "unconfirmed" });
      return { ref: again.ref };
    },
    async listDestinations(didRef) {
      return rows(await call("diddestination", "read", { filter: eq("id_did", didRef), limit: 10 }))
        .filter((x) => String(x.id_did) === String(didRef))
        .map((x) => ({ ref: String(x.id), target: fromPlatform(x.destination), active: String(x.activated) === "1" }));
    },
    async createDestination({ didRef, target }) {
      // target is the SIP destination string chosen by staff configuration (e.g. PJSIP/<number>@<trunk>); voip_call 1 = SIP destination per the schema in use
      const j = await call("diddestination", "save", { id: 0, id_did: didRef, id_user: serviceAccount.ref, destination: toPlatform(target), voip_call: 1, priority: 1, activated: 1 });
      if (j?.success !== true) throw Object.assign(new Error("destination save not confirmed"), { code: "unconfirmed" });
      return { ref: String(j?.rows?.[0]?.id ?? "") || "unconfirmed-ref" };
    },
    trunk,
  };
}
