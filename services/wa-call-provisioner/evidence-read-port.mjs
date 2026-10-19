// READ port for VERIFY-ONLY mode (first live slice): finds and reads back the records staff created, through the existing read-only line-evidence
// adapter (GET /v1/voice/did/:number). This service then holds no voice-platform credential at all, only the adapter's bearer token.
// The adapter applies the exact "wa<number>" ingress alias itself, so a WhatsApp number routed through a prefixed DID row is found under its real number.
// There are no write operations: createAccount/createDid/createDestination refuse, and the provisioner never reaches them in verify-only mode.
import { fromPlatform } from "./magnus-api-port.mjs";

export function evidenceReadPort({ baseUrl, token, serviceAccount, timeoutMs = 8000, fetchImpl = fetch }) {
  if (!baseUrl || !token) throw new Error("evidence read port: missing configuration");
  if (!serviceAccount?.ref || !serviceAccount?.workspaceId) throw new Error("evidence read port: the fixed service account {workspaceId, ref} is required");
  const base = baseUrl.replace(/\/+$/, "");
  async function read(number) {
    if (!/^\d{7,15}$/.test(String(number))) throw Object.assign(new Error("bad number"), { code: "bad_input" });
    const res = await fetchImpl(`${base}/v1/voice/did/${number}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) { const e = new Error(`evidence ${res.status}`); e.status = res.status; throw e; } // never echo the body
    return j;
  }
  // A ref carries the number it was read under, so a later read-back needs no second lookup table and survives a restart.
  const refOf = (didRow, number) => `${didRow.ref}@${number}`;
  const parse = (ref) => { const m = /^(\d+)@(\d{7,15})$/.exec(String(ref)); if (!m) throw Object.assign(new Error("unknown ref form"), { code: "bad_input" }); return { id: m[1], number: m[2] }; };
  const refuse = () => { throw Object.assign(new Error("read-only port: staff create this record"), { code: "staff_action_required" }); };
  return {
    readOnly: true,
    async findAccount(workspaceId) { return serviceAccount.workspaceId === workspaceId ? { ref: String(serviceAccount.ref) } : null; },
    async findDid(number) {
      const j = await read(number);
      // accountRef null = the read-only source cannot see the owner; the provisioner reports that as not verified, never as a match.
      return j.did ? { ref: refOf(j.did, number), accountRef: j.did.accountRef } : null;
    },
    async getDid(ref) {
      const { id, number } = parse(ref);
      const j = await read(number);
      return j.did && j.did.ref === id ? { ref, active: j.did.activated } : null; // a different row under the same number is not this DID
    },
    async listDestinations(ref) {
      const { id, number } = parse(ref);
      const j = await read(number);
      if (!j.did || j.did.ref !== id) return [];
      return j.destinations.map((d) => ({ ref: d.ref, target: fromPlatform(d.destination), active: d.activated }));
    },
    createAccount: refuse, createDid: refuse, createDestination: refuse,
  };
}
