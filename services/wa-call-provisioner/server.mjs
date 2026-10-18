// HTTP front of the provisioner (internal network only). Requests are HMAC-signed by SeldonFrame; the provisioner independently re-checks with SeldonFrame that the
// workspace really holds the number before it touches anything (it does not trust the caller's word). Exactly these routes exist; anything else is 404.
import crypto from "node:crypto";
import http from "node:http";

import { httpPort } from "./magnus-http-port.mjs";
import { makeProvisioner, ProvisionerError } from "./provisioner.mjs";
import { openStore } from "./store.mjs";

export const sign = (secret, ts, body) => crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

export function makeHandler({ prov, secret, verifyBinding, now = () => Date.now() }) {
  const ROUTES = {
    "/v1/ensure-service-account": (b) => prov.ensureServiceAccount({ key: b.key, workspaceId: b.workspaceId }),
    "/v1/ensure-did": (b) => prov.ensureDid({ key: b.key, accountRef: b.accountRef, number: b.number }),
    "/v1/ensure-destination": (b) => prov.ensureDestination({ key: b.key, didRef: b.didRef, target: b.target }),
    "/v1/read-back": (b) => prov.readBack({ didRef: b.didRef }),
  };
  return async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const handler = req.method === "POST" ? ROUTES[req.url] : undefined;
    if (!handler) return reply(404, { error: "not_found" });
    const ts = Number(req.headers["x-prov-ts"]); const sig = String(req.headers["x-prov-sig"] ?? "");
    const want = sign(secret, ts, raw);
    const ok = Number.isFinite(ts) && Math.abs(now() - ts) < 60_000 && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    if (!ok) return reply(401, { error: "bad_signature" });
    let b; try { b = JSON.parse(raw); } catch { return reply(400, { error: "bad_json" }); }
    if (typeof b.key !== "string" || !b.key || typeof b.workspaceId !== "string" || typeof b.phoneNumberId !== "string") return reply(400, { error: "bad_input" });
    if (!(await verifyBinding(b.workspaceId, b.phoneNumberId))) return reply(403, { error: "binding_not_confirmed" });
    try { return reply(200, await handler(b)); }
    catch (e) {
      if (e instanceof ProvisionerError) return reply(e.code === "busy" ? 409 : e.code === "needs_review" ? 422 : e.code === "lease_expired" ? 503 : 409, { error: e.code });
      return reply(502, { error: "upstream_unavailable_or_ambiguous" }); // never leaks upstream detail
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
  const secret = need("PROV_SHARED_SECRET");
  const crashOnce = process.env.FAULT_CRASH_AFTER_WRITE === "1";
  const store = openStore(process.env.PROV_DB || "/data/prov.sqlite");
  const prov = makeProvisioner({
    store, port: httpPort(need("UPSTREAM_URL")),
    leaseMs: Number(process.env.LEASE_MS || 30_000), callTimeoutMs: Number(process.env.CALL_TIMEOUT_MS || 5_000),
    hooks: { afterUpstreamWrite: async () => { if (crashOnce) { console.error("FAULT: crashing after an upstream write"); process.exit(1); } } },
  });
  const sfBase = need("SF_BASE_URL");
  const verifyBinding = async (workspaceId, phoneNumberId) => {
    const q = `workspaceId=${encodeURIComponent(workspaceId)}&phoneNumberId=${encodeURIComponent(phoneNumberId)}`; const ts = Date.now();
    try {
      const r = await fetch(`${sfBase}/api/internal/phone-whatsapp/binding?${q}`, { headers: { "x-prov-ts": String(ts), "x-prov-sig": sign(secret, ts, q) }, signal: AbortSignal.timeout(5000) });
      return r.ok && (await r.json()).bound === true;
    } catch { return false; } // fail closed
  };
  const recovered = await prov.recover();
  http.createServer(makeHandler({ prov, secret, verifyBinding })).listen(Number(process.env.PORT || 9300), "0.0.0.0", () =>
    console.log(`provisioner up; reconciled ${recovered.length} unfinished operation(s)`)); // announce only once it is actually listening
  process.on("SIGTERM", () => process.exit(0));
}
