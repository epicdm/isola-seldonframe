// SIMULATED voice platform ("controlled test double"): NOT Magnus and not evidence about Magnus. It reproduces only the two properties the provisioner relies on,
// both measured read-only on the real schema earlier: a DID number is UNIQUE, a DID's destinations are NOT unique. It also answers the read-only line-evidence
// contract (line-evidence/v1) so the existing SeldonFrame panel path can read "routing" from it in the preview.
//   Provisioning API (used by the provisioner):  POST /api/{account|did|dest}/{find|create|get|list}
//   Admin (tests and the preview only):          POST /__admin/{line|simulate-call|reroute|reset}, GET /__admin/state
import http from "node:http";

export function startFakeMagnus({ port = 0, evidenceToken = "", logger = () => {} } = {}) {
  const t = { accounts: new Map(), dids: new Map(), dests: [], lines: new Map(), cdrs: [], seq: 0 };
  const id = (p) => `${p}-${++t.seq}`;
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* */ }
    const url = new URL(req.url, "http://x"); const p = url.pathname;
    logger(req.method, p);
    if (p === "/api/account/find") { const a = [...t.accounts.values()].find((x) => x.tag === b.tag); return json(res, 200, { account: a ?? null }); }
    if (p === "/api/account/create") { const a = { ref: id("acct"), tag: b.tag }; t.accounts.set(a.ref, a); return json(res, 200, { account: a }); }
    if (p === "/api/did/find") { return json(res, 200, { did: t.dids.get(b.number) ?? null }); }
    if (p === "/api/did/get") { return json(res, 200, { did: [...t.dids.values()].find((d) => d.ref === b.ref) ?? null }); }
    if (p === "/api/did/create") {
      if (t.dids.has(b.number)) return json(res, 409, { error: "duplicate_number" }); // UNIQUE(did)
      const d = { ref: id("did"), number: b.number, accountRef: b.accountRef, tag: b.tag, active: true }; t.dids.set(b.number, d); return json(res, 200, { did: d });
    }
    if (p === "/api/dest/list") { return json(res, 200, { rows: t.dests.filter((x) => x.didRef === b.didRef) }); }
    if (p === "/api/dest/create") { const r = { ref: id("route"), didRef: b.didRef, target: b.target, active: true }; t.dests.push(r); return json(res, 200, { row: r }); } // NOT unique
    // ---- read-only evidence contract
    const m = p.match(/^\/v1\/lines\/(\d+)$/);
    if (m) {
      if (evidenceToken && (req.headers.authorization || "") !== `Bearer ${evidenceToken}`) return json(res, 401, { error: "unauthorised" });
      const line = t.lines.get(m[1]); if (!line) return json(res, 404, { error: "unknown line" });
      const did = t.dids.get(line.displayNumber); const rows = did ? t.dests.filter((x) => x.didRef === did.ref) : [];
      return json(res, 200, {
        schema: "line-evidence/v1", wabaId: url.searchParams.get("waba"), phoneNumberId: m[1], observedAt: new Date().toISOString(),
        meta: { ok: true, displayNumber: `+${line.displayNumber}`, verifiedName: "Fictional Test Co", status: "CONNECTED", codeVerification: "VERIFIED", quality: "GREEN", nameStatus: "APPROVED", platformType: "CLOUD_API", messagingLimitTier: "TIER_250", canReceiveCallSip: "AVAILABLE", extraFieldsError: null },
        calling: { ok: true, status: "ENABLED", sipStatus: "ENABLED", sipHost: "voice.example.test", sipPort: 5061, callIconVisibility: "DEFAULT" },
        magnus: { ok: true, did: did ? { activated: did.active, reserved: true } : null, destination: rows.length ? { value: rows[0].target, kind: "simulated", activated: rows[0].active, count: rows.length } : null,
          lastCalls: t.cdrs.filter((c) => c.number === line.displayNumber).slice(-5).map((c) => ({ startedAt: c.startedAt, durationSec: c.seconds, answered: c.answered, terminateCauseId: 1 })), note: "SIMULATED voice platform" },
      });
    }
    // ---- admin (tests / preview)
    if (p === "/__admin/line") { t.lines.set(b.phoneNumberId, { displayNumber: String(b.displayNumber).replace(/\D/g, "") }); return json(res, 200, { ok: true }); }
    if (p === "/__admin/simulate-call") { t.cdrs.push({ number: String(b.number).replace(/\D/g, ""), answered: b.answered !== false, seconds: b.seconds ?? 30, startedAt: b.startedAt ?? new Date().toISOString() }); return json(res, 200, { ok: true }); }
    if (p === "/__admin/reroute") { for (const r of t.dests) if (r.didRef === b.didRef || t.dids.get(b.number)?.ref === r.didRef) r.target = b.target; return json(res, 200, { ok: true }); }
    if (p === "/__admin/state") return json(res, 200, { accounts: t.accounts.size, dids: t.dids.size, dests: t.dests.length, destRows: t.dests, cdrs: t.cdrs.length });
    if (p === "/__admin/reset") { t.accounts.clear(); t.dids.clear(); t.dests.length = 0; t.lines.clear(); t.cdrs.length = 0; return json(res, 200, { ok: true }); }
    json(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve({ server, port: server.address().port, tables: t, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && process.argv[1].endsWith("fake-magnus.mjs")) {
  const { port } = await startFakeMagnus({ port: Number(process.env.PORT || 9200), evidenceToken: process.env.EVIDENCE_TOKEN || "" });
  console.log(`fake-magnus (SIMULATED) on ${port}`);
  process.on("SIGTERM", () => process.exit(0));
}
