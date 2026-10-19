// PATH test (opt-in: PROV_READ_PATH_TEST=replica): SeldonFrame's REAL attach orchestration and provisioner client -> provisioner HTTP (verify-only,
// UPSTREAM_KIND=line-evidence) -> read port -> line-evidence adapter HTTP (sql mode, exact wa<number> alias) -> SELECT-only account -> MariaDB replica
// (live schema, delta rows). Fake: only SeldonFrame's binding endpoint (its own tests cover it). Every refusal has a positive twin.
// Env: DB_HOST DB_PORT RO_USER RO_PW ROOT_PW SF_SRC (path to packages/crm/src/lib/phone-whatsapp/service), and the replica's fixture values
// T_NUMBER T_DID_ID (the aliased number and its wa<number> DID row id), T_ROUTED_NUMBER T_ROUTED_DID_ID (a DID that already routes elsewhere),
// T_OTHER_NUMBER (another number on the same trunk), T_UNKNOWN_NUMBER, T_TRUNK. Run with --experimental-transform-types.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUN = process.env.PROV_READ_PATH_TEST === "replica";
const E = process.env;
const N = E.T_NUMBER, D1 = E.T_DID_ID, N2 = E.T_ROUTED_NUMBER, D2 = E.T_ROUTED_DID_ID, N3 = E.T_OTHER_NUMBER, NU = E.T_UNKNOWN_NUMBER, TR = E.T_TRUNK;
const here = path.dirname(fileURLToPath(import.meta.url));
const PROV = path.join(here, "..", "server.mjs");
const ADAPTER = path.join(here, "..", "..", "..", "packages", "line-evidence-adapter", "server.mjs");
const SECRET = crypto.randomBytes(24).toString("hex"), TOKEN = crypto.randomBytes(24).toString("hex");
const WS = "ws-a-fict", OTHER_WS = "ws-b-fict";
const PA = "900000000000002", PB = "900000000000003", PUNK = "900000000000004";
const BOUND = new Set([`${WS}|${PA}`, `${WS}|${PB}`, `${WS}|${PUNK}`]);
const DEST = { id: "dest-fict", label: "Office queue", kind: "pbx_queue", target: { trunk: TR, ext: N }, workspaceId: WS, status: "active" };
const REF = `${D1}@${N}`, PJ = `PJSIP/${N}@${TR}`;
const sign = (ts, body) => crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zz-provread-"));
const procs = []; let sfSrv; const ports = {};
let attachService, makeProvisionerClient, root;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
async function start(file, env, readyText) {
  const port = await freePort();
  const p = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p); let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes(readyText); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.includes(readyText), `${path.basename(file)} did not start: ${out}`);
  return port;
}
const adapterEnv = (aliases) => ({ ADAPTER_TOKEN: TOKEN, META_WA_TOKEN: "unused-in-this-path", MAGNUS_DB_HOST: E.DB_HOST, MAGNUS_DB_PORT: E.DB_PORT ?? "3306", MAGNUS_DB_USER: E.RO_USER, MAGNUS_DB_PASSWORD: E.RO_PW, BIND: "127.0.0.1", EVIDENCE_RPM: "600", ...(aliases ? { MAGNUS_DID_ALIASES_JSON: aliases } : {}) });
const provEnv = (adapterPort, extra = {}) => {
  const tf = path.join(tmp, `tok-${adapterPort}`); fs.writeFileSync(tf, TOKEN, { mode: 0o600 });
  return { PROV_SHARED_SECRET: SECRET, SF_BASE_URL: `http://127.0.0.1:${ports.sf}`, PROV_DB: path.join(tmp, `prov-${adapterPort}.sqlite`), UPSTREAM_KIND: "line-evidence", PROV_MODE: "verify-only", EVIDENCE_URL: `http://127.0.0.1:${adapterPort}`, EVIDENCE_TOKEN_FILE: tf, SERVICE_ACCOUNT_JSON: JSON.stringify({ workspaceId: WS, ref: "1" }), ...extra };
};
function memLedger() {
  const m = new Map(); const k = (w, p) => `${w}|${p}`;
  return {
    async get(w, p) { return m.get(k(w, p)) ?? null; },
    async begin({ workspaceId: w, phoneNumberId: p, idempotencyKey, destinationId, now, leaseMs }) {
      const r = m.get(k(w, p)); if (r?.leaseUntil && new Date(r.leaseUntil) > now && r.status === "in_progress") return false;
      m.set(k(w, p), { idempotencyKey, destinationId, steps: r?.steps ?? {}, status: "in_progress", leaseUntil: new Date(now.getTime() + leaseMs).toISOString() }); return true;
    },
    async recordStep({ workspaceId: w, phoneNumberId: p, step, rec }) { m.get(k(w, p)).steps[step] = rec; },
    async finish({ workspaceId: w, phoneNumberId: p, status }) { const r = m.get(k(w, p)); r.status = status; r.leaseUntil = null; },
  };
}
const client = (provPort, phone, ws = WS) => makeProvisionerClient({ baseUrl: `http://127.0.0.1:${provPort}`, secret: SECRET, workspaceId: ws, phoneNumberId: phone });
const attach = (provPort, phone, number, ledger = memLedger()) => attachService({ workspaceId: WS, phoneNumberId: phone, number, destinationId: DEST.id, pre: { connectionStatus: "active", claimants: [WS], selectable: [DEST] } }, { ledger, prov: client(provPort, phone), now: () => new Date() });
// pkg_did_destination.creationdate is ON UPDATE current_timestamp(), so the readback test's own restore moves it: hash every other column instead.
const checksum = async () => {
  const [a] = await root.query("CHECKSUM TABLE pkg_did");
  const [b] = await root.query("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, id_did, id_user, id_ivr, id_queue, id_sip, voip_call, destination, context, priority, activated) ORDER BY id)) AS h FROM pkg_did_destination");
  return `pkg_did:${a[0].Checksum},pkg_did_destination:${b[0].n}:${b[0].h}`;
};

before(async () => {
  if (!RUN) return;
  for (const k of ["T_NUMBER", "T_DID_ID", "T_ROUTED_NUMBER", "T_ROUTED_DID_ID", "T_OTHER_NUMBER", "T_UNKNOWN_NUMBER", "T_TRUNK"]) assert.ok(E[k], `missing ${k}`);
  ({ attachService } = await import(path.join(E.SF_SRC, "attach.ts")));
  ({ makeProvisionerClient } = await import(path.join(E.SF_SRC, "provisioner-client.ts")));
  const mysql = (await import("mysql2/promise")).default;
  root = await mysql.createConnection({ host: E.DB_HOST, port: Number(E.DB_PORT ?? 3306), user: "root", password: E.ROOT_PW, database: "mbilling" });
  sfSrv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); const q = u.search.slice(1); const ts = Number(req.headers["x-prov-ts"]);
    const ok = u.pathname === "/api/internal/phone-whatsapp/binding" && req.headers["x-prov-sig"] === sign(ts, q);
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ bound: ok && BOUND.has(`${u.searchParams.get("workspaceId")}|${u.searchParams.get("phoneNumberId")}`) }));
  });
  ports.sf = await listen(sfSrv);
  ports.adapter = await start(ADAPTER, adapterEnv(JSON.stringify({ [N]: `wa${N}` })), "listening");
  ports.adapterNoAlias = await start(ADAPTER, adapterEnv(null), "listening");
  ports.prov = await start(PROV, provEnv(ports.adapter), "provisioner up");
  ports.provNoAlias = await start(PROV, provEnv(ports.adapterNoAlias), "provisioner up");
  ports.sum0 = await checksum();
});
after(async () => { for (const p of procs) p.kill("SIGTERM"); sfSrv?.close(); await root?.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("aliased number through the real path: attach succeeds by readback; the DID is the prefixed row found under the REAL number", { skip: !RUN }, async () => {
  const r = await attach(ports.prov, PA, N);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.refs.did, REF);
  assert.deepEqual(await client(ports.prov, PA).readBack({ didRef: REF }), { didActive: true, destination: { target: `${TR}/${N}`, active: true }, destinationCount: 1 });
  const again = await attach(ports.prov, PA, N); // a repeat changes nothing and succeeds
  assert.equal(again.ok, true);
});
test("control: the SAME request through an adapter WITHOUT the alias finds no DID -> staff_action_required (the alias is what finds it)", { skip: !RUN }, async () => {
  const r = await attach(ports.provNoAlias, PA, N);
  assert.deepEqual([r.ok, r.code, r.step], [false, "staff_action_required", "did"]);
});
test("unknown number (no DID row): staff_action_required, nothing created (twin: the aliased number above succeeds)", { skip: !RUN }, async () => {
  const r = await attach(ports.prov, PUNK, NU);
  assert.deepEqual([r.ok, r.code, r.step], [false, "staff_action_required", "did"]);
});
test("a number that already routes elsewhere is never claimed: did_has_other_destination", { skip: !RUN }, async () => {
  const c = client(ports.prov, PB);
  const acct = await c.ensureServiceAccount({ key: "k-acct-b" });
  const did = await c.ensureDid({ key: "k-did-b", accountRef: acct.ref, number: N2 });
  assert.equal(did.ref, `${D2}@${N2}`);
  await assert.rejects(c.ensureDestination({ key: "k-dest-b", didRef: did.ref, target: { trunk: TR, ext: N2 } }), (e) => e.code === "did_has_other_destination");
});
test("signature and binding refusals at the provisioner (twin: the signed, bound requests above succeed)", { skip: !RUN }, async () => {
  const body = JSON.stringify({ key: "rb:x", didRef: REF, workspaceId: WS, phoneNumberId: PA });
  const bad = await fetch(`http://127.0.0.1:${ports.prov}/v1/read-back`, { method: "POST", headers: { "x-prov-ts": String(Date.now()), "x-prov-sig": "0".repeat(64) }, body });
  assert.equal(bad.status, 401);
  await assert.rejects(client(ports.prov, PA, OTHER_WS).readBack({ didRef: REF }), (e) => e.status === 403 && e.code === "binding_not_confirmed");
});
test("readback is accurate: a deactivated destination, a changed target or a deactivated DID each read back as such; restored reads true", { skip: !RUN }, async () => {
  const rb = () => client(ports.prov, PA).readBack({ didRef: REF });
  try {
    await root.query("UPDATE pkg_did_destination SET activated = 0 WHERE id_did = ?", [D1]);
    assert.deepEqual((await rb()).destination, { target: `${TR}/${N}`, active: false });
    await root.query("UPDATE pkg_did_destination SET activated = 1, destination = ? WHERE id_did = ?", [`PJSIP/${N3}@${TR}`, D1]);
    assert.deepEqual((await rb()).destination, { target: `${TR}/${N3}`, active: true });
    await root.query("UPDATE pkg_did_destination SET destination = ? WHERE id_did = ?", [PJ, D1]);
    await root.query("UPDATE pkg_did SET activated = 0 WHERE id = ?", [D1]);
    assert.equal((await rb()).didActive, false);
  } finally {
    await root.query("UPDATE pkg_did SET activated = 1 WHERE id = ?", [D1]);
    await root.query("UPDATE pkg_did_destination SET activated = 1, destination = ? WHERE id_did = ?", [PJ, D1]);
  }
  assert.deepEqual(await rb(), { didActive: true, destination: { target: `${TR}/${N}`, active: true }, destinationCount: 1 });
});
test("nothing on the voice platform was written by the whole run (checksums equal; control: a root mutation DOES change them while it lasts)", { skip: !RUN }, async () => {
  assert.equal(await checksum(), ports.sum0);
  await root.query("UPDATE pkg_did SET activated = 0 WHERE id = ?", [D1]); const changed = await checksum();
  await root.query("UPDATE pkg_did SET activated = 1 WHERE id = ?", [D1]);
  assert.notEqual(changed, ports.sum0); assert.equal(await checksum(), ports.sum0);
});
test("the read-only upstream refuses to run in write mode (exits 2)", { skip: !RUN }, async () => {
  const port = await freePort();
  const p = spawn(process.execPath, [PROV], { env: { PATH: process.env.PATH, ...provEnv(ports.adapter, { PROV_MODE: "" }), PORT: String(port) }, stdio: "ignore" });
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 2);
});
