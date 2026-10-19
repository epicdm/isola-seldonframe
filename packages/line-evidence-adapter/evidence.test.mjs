import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { collectLineEvidence, readMeta, readMagnus, magnusRead } from "./evidence.mjs";
import { configFromEnv, makeHandler } from "./server.mjs";

const rnd = (n) => `fixture-${n}-${crypto.randomBytes(9).toString("hex")}`; // generated per run: no credential-shaped literal in the file
const cfg = { metaBase: "https://graph.test/v25.0", metaToken: rnd("meta"), magnusUrl: "https://magnus.test/mbilling", magnusKey: rnd("key"), magnusSecret: rnd("sign"), timeoutMs: 2000 };
const WABA = "100000000000001", PNID = "111222333444555", DID = "15550100001";
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

// Fake Meta + Magnus. `o` toggles failures. Records every call so tests can prove what was (not) requested.
function world(o = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null, headers: init.headers ?? {} });
    const u = String(url);
    if (u.startsWith(cfg.metaBase)) {
      const p = u.slice(cfg.metaBase.length + 1);
      if (o.metaDown) return json({ error: { message: "boom (token abc)" } }, 500);
      if (p.startsWith(`${WABA}/phone_numbers`)) return json({ data: o.notOnWaba ? [{ id: "999" }] : [{ id: "1" }, { id: PNID }] });
      if (p === `${PNID}/settings?fields=calling`) return o.callingFail ? json({ error: { message: "no settings" } }, 400) : json({ calling: { status: o.callingStatus ?? "ENABLED", sip: { status: "ENABLED", servers: [{ hostname: "voice.example.test", port: 5061 }] } } });
      if (p.startsWith(`${PNID}?fields=platform_type`)) return o.extraFail ? json({ error: { message: "(#100) field not available" } }, 400) : json({ platform_type: "CLOUD_API", whatsapp_business_manager_messaging_limit: "TIER_2K", health_status: { can_send_message: "AVAILABLE", entities: [{ entity_type: "WABA", id: WABA, can_send_message: "AVAILABLE" }, { entity_type: "PHONE_NUMBER", id: PNID, can_send_message: "AVAILABLE", can_receive_call_sip: "AVAILABLE" }] } });
      if (p.startsWith(`${PNID}?fields=id`)) return json({ id: PNID, display_phone_number: "+1 555-010-0001", verified_name: "EPIC", status: "CONNECTED", code_verification_status: "VERIFIED", quality_rating: "GREEN", name_status: "APPROVED" });
    }
    if (u.startsWith(cfg.magnusUrl)) {
      const mod = u.split("/").slice(-2)[0];
      if (o.magnusDown) return json({ status: "error", message: "denied" });
      if (mod === "did") return json({ rows: o.noDid ? [] : (o.wholeTable ? [{ id: 5, did: "111", activated: "1", reserved: "1" }, { id: 20, did: DID, activated: "1", reserved: "1" }] : [{ id: 20, did: DID, activated: "1", reserved: "1" }]) });
      if (mod === "diddestination") return json({ rows: [{ id_did: "20", destination: "PJSIP/15550100001@pbx-trunk", id_sip: "154", activated: "1" }] });
      if (mod === "call") return json({ rows: [{ calledstation: DID, starttime: "2026-10-17 12:57:27", sessiontime: "3", terminatecauseid: "1" }, { calledstation: DID, starttime: "2026-10-17 04:00:00", sessiontime: "0", terminatecauseid: "3" }] });
    }
    return json({ error: "unexpected " + u }, 404);
  };
  return { f, calls };
}

test("happy path: facts from Meta and Magnus, times normalised to UTC ISO, schema v1", async () => {
  const w = world();
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f, () => new Date("2026-10-17T19:00:00Z"));
  assert.equal(ev.schema, "line-evidence/v1");
  assert.equal(ev.meta.ok, true); assert.equal(ev.meta.status, "CONNECTED"); assert.equal(ev.meta.platformType, "CLOUD_API"); assert.equal(ev.meta.messagingLimitTier, "TIER_2K"); assert.equal(ev.meta.canReceiveCallSip, "AVAILABLE");
  assert.equal(ev.calling.ok, true); assert.equal(ev.calling.sipHost, "voice.example.test"); assert.equal(ev.calling.sipPort, 5061);
  assert.equal(ev.magnus.destination.value, "PJSIP/15550100001@pbx-trunk"); assert.equal(ev.magnus.destination.kind, "pjsip_trunk");
  assert.equal(ev.magnus.lastCalls[0].startedAt, "2026-10-17T12:57:27.000Z"); assert.equal(ev.magnus.lastCalls[0].answered, true); assert.equal(ev.magnus.lastCalls[1].answered, false);
  assert.equal(ev.observedAt, "2026-10-17T19:00:00.000Z");
});

test("READ-ONLY: every Magnus request is the read action; no write verb exists in any request", async () => {
  const w = world();
  await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  const mag = w.calls.filter((c) => c.url.startsWith(cfg.magnusUrl));
  assert.ok(mag.length >= 3, "positive control: Magnus was actually called");
  for (const c of mag) { assert.match(c.url, /\/read$/); assert.match(c.body, /(^|&)action=read(&|$)/); assert.equal(c.method, "POST"); assert.ok(!/save|delete|destroy|update/i.test(c.url + c.body)); }
  for (const c of w.calls.filter((x) => x.url.startsWith(cfg.metaBase))) assert.equal(c.method, "GET");
});

test("Magnus request is HMAC-signed over the exact body and carries Key/Sign", async () => {
  const w = world();
  await magnusRead(cfg, "did", [{ field: "did", value: DID, type: "string" }], {}, w.f);
  const c = w.calls[0];
  assert.equal(c.headers.Key, cfg.magnusKey);
  assert.equal(c.headers.Sign, crypto.createHmac("sha512", cfg.magnusSecret).update(c.body).digest("hex"));
  assert.match(c.body, /filter=%5B%7B%22type%22%3A%22string%22/);
});

test("a Magnus filter that was not honoured (whole table returned) keeps only the exact match", async () => {
  const w = world({ wholeTable: true });
  const r = await magnusRead(cfg, "did", [{ field: "did", value: DID, type: "string" }], {}, w.f);
  assert.equal(r.rows.length, 1); assert.equal(r.dropped, 1); assert.equal(r.rows[0].did, DID);
});

test("number not on the linked WABA: meta ok:false, calling NOT read, magnus NOT read (no calls past the failure)", async () => {
  const w = world({ notOnWaba: true });
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  assert.equal(ev.meta.ok, false); assert.match(ev.meta.error, /not on the linked WhatsApp business account/);
  assert.equal(ev.calling.ok, false); assert.equal(ev.magnus.ok, false);
  assert.equal(w.calls.filter((c) => c.url.startsWith(cfg.magnusUrl)).length, 0);
});

test("Meta outage: ok:false with the actual failure, token never appears in any output", async () => {
  const w = world({ metaDown: true });
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  assert.equal(ev.meta.ok, false); assert.match(ev.meta.error, /Meta HTTP 500/);
  assert.ok(!JSON.stringify(ev).includes(cfg.metaToken));
});

test("extended Meta fields unavailable: base facts kept, extra fields null with the reason", async () => {
  const w = world({ extraFail: true });
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  assert.equal(ev.meta.ok, true); assert.equal(ev.meta.platformType, null); assert.match(ev.meta.extraFieldsError, /field not available/);
});

test("per-number SIP health is taken only from THIS number's entity (another number's entry is ignored)", async () => {
  const w = world();
  const orig = w.f;
  const f = async (url, init) => {
    if (String(url).includes(`${PNID}?fields=platform_type`)) return json({ platform_type: "CLOUD_API", whatsapp_business_manager_messaging_limit: "TIER_2K", health_status: { entities: [{ entity_type: "PHONE_NUMBER", id: "999999999999999", can_receive_call_sip: "AVAILABLE" }] } });
    return orig(url, init);
  };
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, f);
  assert.equal(ev.meta.canReceiveCallSip, null);
});

test("calling settings read fails independently of the number read", async () => {
  const w = world({ callingFail: true });
  const ev = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  assert.equal(ev.meta.ok, true); assert.equal(ev.calling.ok, false); assert.match(ev.calling.error, /no settings/);
});

test("Magnus failure is reported, Meta facts survive; no DID row = did:null (not an error, not 'ready')", async () => {
  const down = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, world({ magnusDown: true }).f);
  assert.equal(down.meta.ok, true); assert.equal(down.magnus.ok, false); assert.match(down.magnus.error, /Magnus error/);
  const none = await readMagnus(cfg, DID, world({ noDid: true }).f);
  assert.equal(none.ok, true); assert.equal(none.did, null); assert.equal(none.destination, null);
});

test("ingress alias: the Magnus DID and call lookups use wa<number>; the Meta identity stays the number (unaliased twin unchanged)", async () => {
  const aliased = world();
  const ev = await collectLineEvidence({ ...cfg, magnusDidAliases: { [DID]: `wa${DID}` } }, { wabaId: WABA, phoneNumberId: PNID }, aliased.f);
  const looked = aliased.calls.filter((c) => /\/(did|call)\/read$/.test(c.url)).map((c) => decodeURIComponent(c.body));
  assert.ok(looked.length >= 2 && looked.every((b) => b.includes(`"value":"wa${DID}"`)), "both DID and CDR lookups used the alias");
  assert.equal(ev.magnus.ingressKey, `wa${DID}`); assert.equal(ev.meta.displayNumber, "+1 555-010-0001");
  const plain = world();
  const ev2 = await collectLineEvidence(cfg, { wabaId: WABA, phoneNumberId: PNID }, plain.f);
  const looked2 = plain.calls.filter((c) => /\/(did|call)\/read$/.test(c.url)).map((c) => decodeURIComponent(c.body));
  assert.ok(looked2.length >= 2 && looked2.every((b) => b.includes(`"value":"${DID}"`)), "control: no alias = the number itself");
  assert.equal(ev2.magnus.ingressKey, undefined);
});

test("ingress alias can never point a number at ANOTHER number's records", async () => {
  const w = world();
  const ev = await collectLineEvidence({ ...cfg, magnusDidAliases: { [DID]: "wa15550109999" } }, { wabaId: WABA, phoneNumberId: PNID }, w.f);
  assert.equal(ev.magnus.ok, false); assert.match(ev.magnus.error, /does not belong to this number/);
  assert.equal(w.calls.filter((c) => c.url.startsWith(cfg.magnusUrl)).length, 0, "nothing read under a foreign key");
  assert.throws(() => configFromEnv({ ...env, MAGNUS_DID_ALIASES_JSON: JSON.stringify({ [DID]: "wa15550109999" }) }), /the same digits/);
  assert.throws(() => configFromEnv({ ...env, MAGNUS_DID_ALIASES_JSON: JSON.stringify({ [DID]: "15550109999" }) }), /the same digits/);
  assert.throws(() => configFromEnv({ ...env, MAGNUS_DID_ALIASES_JSON: "{not json" }), /not JSON/);
  assert.deepEqual(configFromEnv({ ...env, MAGNUS_DID_ALIASES_JSON: JSON.stringify({ [DID]: `wa${DID}` }) }).magnusDidAliases, { [DID]: `wa${DID}` }); // positive twin
});

test("invalid ids are rejected before any upstream call", async () => {
  const w = world();
  await assert.rejects(collectLineEvidence(cfg, { wabaId: "x; drop", phoneNumberId: PNID }, w.f), /invalid ids/);
  assert.equal(w.calls.length, 0);
});

// ---- server -------------------------------------------------------------------------------------------------------
const env = { MAGNUS_MODE: "rest", ADAPTER_TOKEN: rnd("adapter").padEnd(32, "x"), META_WA_TOKEN: rnd("m"), MAGNUS_URL: "https://magnus.test/mbilling", MAGNUS_API_KEY: rnd("k"), MAGNUS_API_SECRET: rnd("s") };
function call(handler, { method = "GET", url, headers = {} }) {
  return new Promise((resolve) => {
    const res = { writeHead(c) { this.code = c; }, end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null }); } };
    handler({ method, url, headers }, res);
  });
}

test("server refuses to start without config or with a short adapter token", () => {
  assert.throws(() => configFromEnv({ ...env, MAGNUS_API_SECRET: "" }), /missing MAGNUS_API_SECRET/);
  assert.throws(() => configFromEnv({ ...env, ADAPTER_TOKEN: "short" }), /shorter than 24/);
  assert.doesNotThrow(() => configFromEnv(env)); // positive twin
});

test("server: auth, method, validation, healthz (positive twin), cache and rate limit", async () => {
  const w = world(); const c = configFromEnv(env); c.metaBase = cfg.metaBase; c.rpm = 2;
  const h = makeHandler(c, { fetch: w.f, now: () => new Date("2026-10-17T19:00:00Z") });
  const auth = { authorization: "Bearer " + env.ADAPTER_TOKEN };
  assert.equal((await call(h, { url: "/healthz" })).code, 200);
  assert.equal((await call(h, { url: `/v1/lines/${PNID}?waba=${WABA}` })).code, 401);
  assert.equal((await call(h, { url: `/v1/lines/${PNID}?waba=${WABA}`, headers: { authorization: "Bearer wrong" } })).code, 401);
  assert.equal((await call(h, { method: "POST", url: `/v1/lines/${PNID}?waba=${WABA}`, headers: auth })).code, 405);
  assert.equal((await call(h, { url: `/v1/lines/abc?waba=${WABA}`, headers: auth })).code, 400);
  assert.equal(w.calls.length, 0, "nothing reached upstream for any refused request");
  const ok = await call(h, { url: `/v1/lines/${PNID}?waba=${WABA}`, headers: auth });
  assert.equal(ok.code, 200); assert.equal(ok.body.schema, "line-evidence/v1");
  const n = w.calls.length;
  assert.equal((await call(h, { url: `/v1/lines/${PNID}?waba=${WABA}`, headers: auth })).code, 200);
  assert.equal(w.calls.length, n, "second identical request served from cache");
  assert.equal((await call(h, { url: `/v1/lines/222333444555666?waba=${WABA}`, headers: auth })).code, 200);
  assert.equal((await call(h, { url: `/v1/lines/333444555666777?waba=${WABA}`, headers: auth })).code, 429);
});

// Read port route (verify-only provisioner): same source, same exact alias, no Meta call.
import { readVoiceDidFrom } from "./evidence.mjs";
const voiceSrc = (rows, dests) => { const seen = []; return { seen, did: async (k) => (seen.push(k), rows), destinations: async () => dests, calls: async () => [] }; };
test("read port: the aliased key is used, destinations mapped, owner null when the source cannot see it (twin: unaliased reads the plain key)", async () => {
  const s = voiceSrc([{ id: 900, did: "wa15550100001", activated: 1, reserved: 1 }], [{ id_did: 900, destination: "PJSIP/15550100001@trunk-x", activated: 1 }]);
  const r = await readVoiceDidFrom(s, DID, `wa${DID}`);
  assert.deepEqual(s.seen, [`wa${DID}`]);
  assert.deepEqual(r, { ok: true, number: DID, ingressKey: `wa${DID}`, did: { ref: "900", accountRef: null, activated: true, reserved: true }, destinations: [{ ref: "900.1", destination: "PJSIP/15550100001@trunk-x", activated: true }] });
  const p = voiceSrc([], []); assert.deepEqual(await readVoiceDidFrom(p, DID), { ok: true, number: DID, did: null, destinations: [] }); assert.deepEqual(p.seen, [DID]);
});
test("read port: a foreign key is refused with nothing read; two matching rows are ambiguous, never the first", async () => {
  const s = voiceSrc([], []);
  assert.equal((await readVoiceDidFrom(s, DID, "wa15550100002")).ok, false); assert.deepEqual(s.seen, []);
  const two = voiceSrc([{ id: 1, activated: 1 }, { id: 2, activated: 1 }], []);
  assert.match((await readVoiceDidFrom(two, DID)).error, /ambiguous/);
});
test("read port route: bearer required, bad number 400, alias applied, uncached (twin: authorised read 200)", async () => {
  const s = voiceSrc([{ id: 900, activated: 1, reserved: 1 }], []);
  const h = makeHandler({ ...cfg, adapterToken: "t".repeat(32), cacheSeconds: 60, rpm: 30, magnusSource: s, magnusDidAliases: { [DID]: `wa${DID}` } });
  const call = async (url, auth) => { let code, body; const res = { writeHead: (c) => (code = c), end: (b) => (body = JSON.parse(b)) }; await h({ method: "GET", url, headers: auth ? { authorization: `Bearer ${auth}` } : {} }, res); return { code, body }; };
  assert.equal((await call(`/v1/voice/did/${DID}`)).code, 401);
  assert.equal((await call("/v1/voice/did/12ab", "t".repeat(32))).code, 400);
  assert.equal((await call("/v1/voice/did/%E0%A4%A", "t".repeat(32))).code, 400); // Codex review: malformed escape is a bad request, not a 502
  const ok = await call(`/v1/voice/did/${DID}`, "t".repeat(32)); await call(`/v1/voice/did/${DID}`, "t".repeat(32));
  assert.equal(ok.code, 200); assert.equal(ok.body.did.ref, "900"); assert.deepEqual(s.seen, [`wa${DID}`, `wa${DID}`]);
});
