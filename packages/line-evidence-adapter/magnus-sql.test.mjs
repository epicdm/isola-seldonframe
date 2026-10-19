import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SQL, sqlSource } from "./magnus-sql.mjs";
import { readMagnusFrom, restSource, collectLineEvidence } from "./evidence.mjs";
import { configFromEnv } from "./server.mjs";

const rnd = (n) => `fixture-${n}-${crypto.randomBytes(9).toString("hex")}`;
const DID = "15550100001";
const rows = {
  did: [{ id: 20, did: DID, activated: 1, reserved: 1 }],
  destinations: [{ id_did: 20, destination: "PJSIP/15550100001@pbx-trunk", id_sip: 154, activated: 1 }],
  calls: [{ calledstation: DID, starttime: "2026-10-17 12:57:27", sessiontime: 3, terminatecauseid: 1 }, { calledstation: DID, starttime: "2026-10-17 04:00:00", sessiontime: 0, terminatecauseid: 3 }],
};

test("the only SQL the service can run: three constant SELECTs, bound parameters, fixed tables and columns, no interpolation", () => {
  const allowed = { did: ["pkg_did", ["id", "did", "activated", "reserved"]], destinations: ["pkg_did_destination", ["id_did", "destination", "id_sip", "activated"]], calls: ["pkg_cdr", ["calledstation", "starttime", "sessiontime", "terminatecauseid"]] };
  assert.deepEqual(Object.keys(SQL).sort(), Object.keys(allowed).sort());
  for (const [k, [table, cols]] of Object.entries(allowed)) {
    const q = SQL[k];
    assert.match(q, /^SELECT /); assert.ok(!/;|--|\/\*|insert|update|delete|drop|grant|into outfile/i.test(q), k);
    assert.equal((q.match(/\?/g) ?? []).length, 1, "exactly one bound parameter");
    const sel = q.slice(7, q.indexOf(" FROM ")).split(",").map((c) => c.trim());
    assert.deepEqual(sel, cols, `${k} selects exactly its granted columns`);
    assert.match(q, new RegExp(`FROM ${table} WHERE`));
  }
  assert.ok(Object.isFrozen(SQL));
});

test("sql source gives the SAME facts as the REST source for the same rows (shared shaping)", async () => {
  const seen = [];
  const sql = sqlSource(async (text, params) => { seen.push({ text, params }); return text === SQL.did ? rows.did : text === SQL.destinations ? rows.destinations : rows.calls; });
  const viaSql = await readMagnusFrom(sql, DID);
  const rest = { did: async () => rows.did, destinations: async () => rows.destinations, calls: async () => rows.calls };
  assert.deepEqual(viaSql, await readMagnusFrom(rest, DID));
  assert.equal(viaSql.ok, true); assert.equal(viaSql.destination.kind, "pjsip_trunk"); assert.equal(viaSql.lastCalls[0].startedAt, "2026-10-17T12:57:27.000Z"); assert.equal(viaSql.lastCalls[0].answered, true);
  assert.deepEqual(seen.map((s) => s.params), [[DID], [20], [DID]], "values are bound parameters, typed");
});

test("a database failure is reported as ok:false with the reason, never as ready", async () => {
  const r = await readMagnusFrom(sqlSource(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3306"); }), DID);
  assert.equal(r.ok, false); assert.match(r.error, /ECONNREFUSED/);
});

test("sql mode: configuration refuses a Magnus API key, a privileged DB user, and missing settings; a valid one starts (positive twin)", () => {
  const base = { ADAPTER_TOKEN: rnd("adapter").padEnd(32, "x"), META_WA_TOKEN: rnd("m"), MAGNUS_DB_HOST: "127.0.0.1", MAGNUS_DB_USER: "line_evidence_ro", MAGNUS_DB_PASSWORD: rnd("pw") };
  const ok = configFromEnv(base);
  assert.equal(ok.magnusMode, "sql"); assert.equal(ok.magnusKey, undefined); assert.equal(ok.magnusSecret, undefined); assert.equal(ok.magnusDb.database, "mbilling");
  assert.throws(() => configFromEnv({ ...base, MAGNUS_API_KEY: rnd("k") }), /API key is present in sql mode/);
  assert.throws(() => configFromEnv({ ...base, MAGNUS_API_SECRET: rnd("s") }), /API key is present in sql mode/);
  for (const u of ["root", "mbillingUser", "ROOT"]) assert.throws(() => configFromEnv({ ...base, MAGNUS_DB_USER: u }), /dedicated SELECT-only/);
  assert.throws(() => configFromEnv({ ...base, MAGNUS_DB_PASSWORD: "" }), /missing MAGNUS_DB_PASSWORD/);
  assert.throws(() => configFromEnv({ ...base, MAGNUS_MODE: "other" }), /MAGNUS_MODE/);
});

test("with a sql source injected, no request is ever made to the Magnus REST API", async () => {
  const calls = [];
  const cfg = { metaBase: "https://graph.test/v25.0", metaToken: rnd("meta"), magnusUrl: "https://magnus.test/mbilling", timeoutMs: 1000, magnusSource: sqlSource(async (t) => (t === SQL.did ? rows.did : t === SQL.destinations ? rows.destinations : rows.calls)) };
  const f = async (url) => {
    calls.push(String(url));
    const p = String(url).slice(cfg.metaBase.length + 1);
    const j = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (p.startsWith("100000000000001/phone_numbers")) return j({ data: [{ id: "111222333444555" }] });
    if (p.includes("fields=calling")) return j({ calling: { status: "ENABLED", sip: { status: "ENABLED", servers: [{ hostname: "voice.example.test", port: 5061 }] } } });
    if (p.includes("fields=id,display")) return j({ id: "111222333444555", display_phone_number: "+1 555-010-0001", status: "CONNECTED" });
    return j({});
  };
  const ev = await collectLineEvidence(cfg, { wabaId: "100000000000001", phoneNumberId: "111222333444555" }, f);
  assert.equal(ev.magnus.ok, true); assert.equal(ev.magnus.did.reserved, true);
  assert.ok(calls.every((u) => u.startsWith(cfg.metaBase)), "only Meta was called over HTTP");
});
