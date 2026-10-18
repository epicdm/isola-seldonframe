// Provisioner proofs. Everything here runs against the SIMULATED voice platform (fake-magnus.mjs) with fictional data: the results are SIMULATED results, not
// evidence about the real platform. What they prove is the provisioner's own duplicate-prevention logic under the failure modes that matter. Every refusal has
// a positive control in the same file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFakeMagnus } from "../fake-magnus.mjs";
import { startFaultProxy } from "../fault-proxy.mjs";
import { httpPort } from "../magnus-http-port.mjs";
import { makeProvisioner } from "../provisioner.mjs";
import { makeHandler, sign } from "../server.mjs";
import { openStore } from "../store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "prov-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NUMBER = "15550100100";
const WS = "ws-aaaa";

async function retryBusy(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (e.code !== "busy") throw e; await sleep(5); }
  }
  throw new Error("still busy");
}

let fm, proxy;
const rows = () => ({ accounts: fm.tables.accounts.size, dids: fm.tables.dids.size, dests: fm.tables.dests.length });
const fresh = (over = {}) => {
  const dir = tmp();
  const store = openStore(path.join(dir, "p.sqlite"));
  const prov = makeProvisioner({ store, port: httpPort(`http://127.0.0.1:${proxy.port}`), leaseMs: 5000, callTimeoutMs: 1000, marginMs: 100, ...over });
  return { dir, store, prov };
};
const reset = () => { fm.tables.accounts.clear(); fm.tables.dids.clear(); fm.tables.dests.length = 0; proxy.loseSequence([]); };

before(async () => { fm = await startFakeMagnus(); proxy = await startFaultProxy({ upstreamPort: fm.port }); });
after(async () => { await proxy.close(); await fm.close(); });

describe("duplicate prevention (SIMULATED voice platform)", () => {
  test("positive control: the chain creates exactly one account, one DID, one route; readBack agrees", async () => {
    reset(); const { prov } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    const r = await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "pbx-fictional/900" });
    assert.deepEqual([a.created, d.created, r.created], [true, true, true]);
    assert.deepEqual(rows(), { accounts: 1, dids: 1, dests: 1 });
    assert.deepEqual(await prov.readBack({ didRef: d.ref }), { didActive: true, destination: { target: "pbx-fictional/900", active: true }, destinationCount: 1 });
  });

  test("idempotent: repeating every call changes nothing and reports created:false", async () => {
    reset(); const { prov } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    const a2 = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d2 = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    const r2 = await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    assert.deepEqual([a2.created, d2.created, r2.created], [false, false, false]);
    assert.deepEqual(rows(), { accounts: 1, dids: 1, dests: 1 });
  });

  test("CONCURRENT requests: 25 simultaneous identical calls (and 25 with different keys for the same target) leave exactly one DID and one route", async () => {
    reset(); const { prov } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const dids = await Promise.all(Array.from({ length: 25 }, () => retryBusy(() => prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER }))));
    assert.equal(new Set(dids.map((x) => x.ref)).size, 1);
    assert.equal(rows().dids, 1);
    const same = await Promise.all(Array.from({ length: 25 }, () => retryBusy(() => prov.ensureDestination({ key: "k:dest", didRef: dids[0].ref, target: "t/1" }))));
    assert.equal(new Set(same.map((x) => x.ref)).size, 1);
    assert.equal(rows().dests, 1);
    const diff = await Promise.all(Array.from({ length: 25 }, (_, i) => retryBusy(() => prov.ensureDestination({ key: `other-${i}`, didRef: dids[0].ref, target: "t/1" }))));
    assert.equal(new Set(diff.map((x) => x.ref)).size, 1);
    assert.equal(rows().dests, 1, "different idempotency keys for the same DID+target still cannot create a second route");
  });

  test("CONCURRENT across two provisioner instances sharing one database file (two processes): still one route", async () => {
    reset(); const one = fresh(); const two = { prov: makeProvisioner({ store: openStore(path.join(one.dir, "p.sqlite")), port: httpPort(`http://127.0.0.1:${proxy.port}`), leaseMs: 5000, callTimeoutMs: 1000, marginMs: 100 }) };
    const a = await one.prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await one.prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    await Promise.all(Array.from({ length: 30 }, (_, i) => retryBusy(() => (i % 2 ? one.prov : two.prov).ensureDestination({ key: `x-${i}`, didRef: d.ref, target: "t/1" }))));
    assert.equal(rows().dests, 1);
  });

  test("LOST RESPONSE: the route WAS written but the answer is dropped -> the call reconciles by looking again; one row (control: the write really happened)", async () => {
    reset(); const { prov } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    proxy.loseSequence(["/api/dest/create"]);
    const r = await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    assert.equal(proxy.state.dropped, 1, "control: a response really was dropped");
    assert.equal(r.created, true);
    assert.equal(rows().dests, 1);
  });

  test("LOST RESPONSE and the reconcile lookup ALSO lost: the call fails as ambiguous (state unknown); the retry finds the existing row; still one", async () => {
    reset(); const { prov, store } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    proxy.loseSequence(["/api/dest/create", "/api/dest/list"]);
    await assert.rejects(prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" }));
    assert.equal(rows().dests, 1, "control: the upstream holds the row");
    assert.equal(store.getOp("k:dest").state, "unknown");
    const again = await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    assert.deepEqual([again.created, rows().dests, store.getOp("k:dest").state], [false, 1, "done"]);
  });

  test("LOST RESPONSE on the DID create: the retry (or the immediate reconcile) yields exactly one DID", async () => {
    reset(); const { prov } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    proxy.loseSequence(["/api/did/create", "/api/did/find"]);
    await assert.rejects(prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER }));
    assert.equal(rows().dids, 1);
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    assert.deepEqual([d.created, rows().dids], [false, 1]);
  });

  test("EXPIRED LEASE, dead holder: a lock row left by a crashed process (already expired) is taken over with a higher fencing token; one route", async () => {
    reset(); const { prov, store } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    store._db.prepare("insert into locks (resource, owner, token, expires_at) values (?, 'dead-process', 7, ?)").run(`dest:${d.ref}`, Date.now() - 60_000);
    await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    assert.equal(rows().dests, 1);
    assert.equal(store._db.prepare("select count(*) c from locks").get().c, 0, "lease released after use");
  });

  test("an UNEXPIRED lease held by someone else is respected: the caller is told 'busy' and writes nothing (twin: after release it proceeds)", async () => {
    reset(); const { prov, store } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    store._db.prepare("insert into locks (resource, owner, token, expires_at) values (?, 'other', 3, ?)").run(`dest:${d.ref}`, Date.now() + 60_000);
    await assert.rejects(prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" }), (e) => e.code === "busy");
    assert.equal(rows().dests, 0);
    store.release(`dest:${d.ref}`, 3);
    await prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" });
    assert.equal(rows().dests, 1);
  });

  test("EXPIRED LEASE, stalled holder: a holder whose lease ran out while it was slow REFUSES to write (fencing); the next holder writes; exactly one route", async () => {
    reset();
    const slowStore = openStore(path.join(tmp(), "p.sqlite"));
    const base = httpPort(`http://127.0.0.1:${proxy.port}`);
    let slowOnce = true;
    const slowPort = { ...base, async listDestinations(ref) { const r = await base.listDestinations(ref); if (slowOnce) { slowOnce = false; await sleep(700); } return r; } };
    const A = makeProvisioner({ store: slowStore, port: slowPort, leaseMs: 300, callTimeoutMs: 100, marginMs: 50, owner: "A" });
    const B = makeProvisioner({ store: slowStore, port: base, leaseMs: 300, callTimeoutMs: 100, marginMs: 50, owner: "B" });
    const acct = await B.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const did = await B.ensureDid({ key: "k:did", accountRef: acct.ref, number: NUMBER });
    const aRun = A.ensureDestination({ key: "kA", didRef: did.ref, target: "t/1" });
    await sleep(450); // A's lease (300 ms) has expired while A is still inside its slow lookup
    const b = await B.ensureDestination({ key: "kB", didRef: did.ref, target: "t/1" });
    await assert.rejects(aRun, (e) => e.code === "lease_expired");
    assert.equal(rows().dests, 1);
    assert.equal(b.created, true);
  });

  test("PROCESS RESTART: the process dies right after the upstream write; a new process on the same database reconciles and the retry creates nothing more", async () => {
    reset();
    const dir = tmp(); const db = path.join(dir, "p.sqlite"); const secret = crypto.randomBytes(16).toString("hex");
    const sf = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ bound: true })); });
    await new Promise((r) => sf.listen(0, "127.0.0.1", r));
    const start = (fault, port) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(HERE, "..", "server.mjs")], {
        env: { ...process.env, PORT: String(port), PROV_DB: db, PROV_SHARED_SECRET: secret, UPSTREAM_URL: `http://127.0.0.1:${fm.port}`, SF_BASE_URL: `http://127.0.0.1:${sf.address().port}`, FAULT_CRASH_AFTER_WRITE: fault ? "1" : "0", LEASE_MS: "3000", CALL_TIMEOUT_MS: "300" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = ""; child.stdout.on("data", (d) => { out += d; if (out.includes("provisioner up")) resolve({ child, out: () => out }); });
      child.stderr.on("data", (d) => { out += d; });
    });
    const call = async (port, route, body) => {
      const raw = JSON.stringify({ workspaceId: WS, phoneNumberId: "900000000000002", ...body }); const ts = Date.now();
      try { const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "x-prov-ts": String(ts), "x-prov-sig": sign(secret, ts, raw) }, body: raw }); return { status: r.status, body: await r.json() }; }
      catch { return { status: 0, body: null }; }
    };
    const p1 = await start(true, 9411);
    const acct = await call(9411, "/v1/ensure-service-account", { key: "k:acct" }); // first upstream write crashes the process
    assert.equal(acct.status, 0, "control: the process died mid-request");
    assert.equal(rows().accounts, 1, "control: the write had happened");
    await new Promise((r) => p1.child.once("exit", r));
    const p2 = await start(false, 9412);
    assert.match(p2.out(), /reconciled [1-9]/, "the new process found the unfinished operation");
    // The dead process still "holds" the lease until it expires (a live second instance could not be told apart from a dead one): the retry is told busy, then succeeds.
    let retry = await call(9412, "/v1/ensure-service-account", { key: "k:acct" });
    const firstStatus = retry.status;
    for (let i = 0; i < 40 && retry.status === 409; i++) { await sleep(150); retry = await call(9412, "/v1/ensure-service-account", { key: "k:acct" }); }
    assert.ok([409, 200].includes(firstStatus), "busy while the dead holder's lease is unexpired, or already free");
    assert.deepEqual([retry.status, retry.body.created, rows().accounts], [200, false, 1]);
    p2.child.kill(); sf.close();
  });

  test("a number that already belongs to another account is refused and nothing is written; a destination that would change existing routing is refused", async () => {
    reset(); const { prov } = fresh();
    const a1 = await prov.ensureServiceAccount({ key: "a1", workspaceId: "ws-1" });
    const a2 = await prov.ensureServiceAccount({ key: "a2", workspaceId: "ws-2" });
    const d = await prov.ensureDid({ key: "d1", accountRef: a1.ref, number: NUMBER });
    await assert.rejects(prov.ensureDid({ key: "d2", accountRef: a2.ref, number: NUMBER }), (e) => e.code === "did_owned_elsewhere");
    assert.equal(rows().dids, 1);
    await prov.ensureDestination({ key: "r1", didRef: d.ref, target: "t/1" });
    await assert.rejects(prov.ensureDestination({ key: "r2", didRef: d.ref, target: "t/2" }), (e) => e.code === "did_has_other_destination");
    assert.equal(rows().dests, 1);
  });

  test("pre-existing duplicate identical routes are reported needs_review, never deleted", async () => {
    reset(); const { prov, store } = fresh();
    const a = await prov.ensureServiceAccount({ key: "k:acct", workspaceId: WS });
    const d = await prov.ensureDid({ key: "k:did", accountRef: a.ref, number: NUMBER });
    fm.tables.dests.push({ ref: "r-a", didRef: d.ref, target: "t/1", active: true }, { ref: "r-b", didRef: d.ref, target: "t/1", active: true });
    await assert.rejects(prov.ensureDestination({ key: "k:dest", didRef: d.ref, target: "t/1" }), (e) => e.code === "needs_review");
    assert.equal(store.getOp("k:dest").state, "needs_review");
    assert.equal(rows().dests, 2, "nothing deleted");
  });
});

describe("verify-only mode (first live slice: staff create the records)", () => {
  test("absent records: refused as staff_action_required and NOTHING is created; once staff have created them, the same calls succeed by finding them", async () => {
    reset(); const { prov } = fresh({ allowWrites: false });
    await assert.rejects(prov.ensureServiceAccount({ key: "v:acct", workspaceId: WS }), (e) => e.code === "staff_action_required");
    assert.deepEqual(rows(), { accounts: 0, dids: 0, dests: 0 });
    fm.tables.accounts.set("acct-s", { ref: "acct-s", tag: WS }); // staff created it in the platform UI (simulated)
    const a = await prov.ensureServiceAccount({ key: "v:acct2", workspaceId: WS });
    await assert.rejects(prov.ensureDid({ key: "v:did", accountRef: a.ref, number: NUMBER }), (e) => e.code === "staff_action_required");
    fm.tables.dids.set(NUMBER, { ref: "did-s", number: NUMBER, accountRef: a.ref, active: true });
    const d = await prov.ensureDid({ key: "v:did2", accountRef: a.ref, number: NUMBER });
    fm.tables.dests.push({ ref: "route-s", didRef: d.ref, target: "t/1", active: true });
    const r = await prov.ensureDestination({ key: "v:dest", didRef: d.ref, target: "t/1" });
    assert.deepEqual([a.created, d.created, r.created, rows().dests], [false, false, false, 1]);
  });
});

describe("the service surface", () => {
  const secret = crypto.randomBytes(16).toString("hex");
  const mk = (binding = true) => {
    const { prov } = fresh(); let upstreamCalls = 0;
    const h = makeHandler({ prov: { ...prov, ensureServiceAccount: async (...a) => { upstreamCalls++; return prov.ensureServiceAccount(...a); } }, secret, verifyBinding: async () => binding });
    return { srv: http.createServer(h), calls: () => upstreamCalls };
  };
  const hit = async (srv, route, { body = { key: "k", workspaceId: WS, phoneNumberId: "900000000000002" }, sigSecret = secret, ts = Date.now(), method = "POST" } = {}) => {
    await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const raw = JSON.stringify(body);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${route}`, { method, headers: { "x-prov-ts": String(ts), "x-prov-sig": sign(sigSecret, ts, raw) }, body: method === "POST" ? raw : undefined });
    srv.close(); return r.status;
  };
  test("positive control: a correctly signed, binding-confirmed request is served", async () => { reset(); const { srv } = mk(); assert.equal(await hit(srv, "/v1/ensure-service-account"), 200); });
  test("bad signature and stale timestamp are refused (401) and reach nothing", async () => {
    reset(); const a = mk(); assert.equal(await hit(a.srv, "/v1/ensure-service-account", { sigSecret: "wrong" }), 401); assert.equal(a.calls(), 0);
    const b = mk(); assert.equal(await hit(b.srv, "/v1/ensure-service-account", { ts: Date.now() - 5 * 60_000 }), 401); assert.equal(b.calls(), 0);
  });
  test("a binding SeldonFrame does not confirm is refused (403) before any upstream call", async () => { reset(); const a = mk(false); assert.equal(await hit(a.srv, "/v1/ensure-service-account"), 403); assert.equal(a.calls(), 0); assert.equal(rows().accounts, 0); });
  test("there is no billing, update or delete route: those paths are 404 even when correctly signed", async () => {
    for (const route of ["/v1/charge", "/v1/purchase", "/v1/delete-did", "/v1/update-destination", "/v1/deregister"]) assert.equal(await hit(mk().srv, route), 404, route);
  });
  test("the upstream port exposes only find/get/list/create (no update or delete)", () => {
    assert.deepEqual(Object.keys(httpPort("http://x")).sort(), ["createAccount", "createDestination", "createDid", "findAccount", "findDid", "getDid", "listDestinations"]);
  });
});
