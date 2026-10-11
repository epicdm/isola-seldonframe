// EPIC 2026-10-11 - R1 slice S-a: the three journey event types plsvc defines (pl.signup_started, pl.trial_ending,
// pl.trial_expired) are now ACCEPTED by the receiver. Projection = activity entry + bus event (+ version-guarded
// facts); never a deal move, never a probability. Every refusal has a positive twin in the same run (Law 19).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { signIngress } from "../../src/lib/personal-line/signing";
import { handlePersonalLineWebhook, parsePlEvent, processPlEvent, PL_EVENT_TYPES, type Emit, type EventStore } from "../../src/lib/personal-line/events";

const root = path.resolve(__dirname, "../..");
const KEY = { kid: "ev1", key: "events-unit-key-0123456789abcdef-01234" };
const ORG = "11111111-1111-4111-8111-111111111111";
const now = () => Math.floor(Date.now() / 1000);

function store() {
  const ids: Array<{ k: string; c: string }> = [];
  const inbox = new Set<string>();
  const facts = new Map<string, { v: number; f: Record<string, unknown> }>();
  const acts: any[] = [];
  const s: EventStore = {
    async findIdentityByExternal(_o, _p, e) { const r = ids.find((x) => x.k === e); return r ? { contactId: r.c } : null; },
    async contactExists() { return true; },
    async setContactPhone() {},
    async createContact() { return `c${ids.length + 1}`; },
    async insertIdentity(_o, _p, e, c) { if (ids.some((x) => x.k === e)) return false; ids.push({ k: e, c }); return true; },
    async deleteContact() {},
    async claimEvent(_o, e) { if (inbox.has(e.eventId)) return false; inbox.add(e.eventId); return true; },
    async applyFactsIfNewer(o, acc, v, f) { const k = `${o}|${acc}`; const cur = facts.get(k); if (cur && cur.v >= v) return false; facts.set(k, { v, f: { ...(cur?.f ?? {}), ...f } }); return true; },
    async addActivity(o, c, a) { acts.push({ o, c, ...a }); return true; },
    async finishEvent() {},
  };
  const emitted: any[] = [];
  const emit: Emit = async (type, data, orgId) => { emitted.push({ type, data, orgId }); };
  return { s, emit, emitted, acts, facts };
}
const ev = (over: Record<string, unknown> = {}) => JSON.stringify({
  event_id: "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d6e", type: "pl.line_created", occurred_at: "2026-10-11T12:00:00Z", version: 1,
  pl_account_id: "accA", wa_id: "17675550101", facts: {}, ...over,
});
const TRIAL = { trial_end: "2026-10-18T04:00:00Z" };

test("S-a parse: the three new types are accepted with their proof facts; trial_* without trial_end is refused (control: with it, accepted)", () => {
  assert.equal(parsePlEvent(ev({ type: "pl.signup_started" }))?.type, "pl.signup_started");
  assert.equal(parsePlEvent(ev({ type: "pl.trial_ending", facts: TRIAL }))?.type, "pl.trial_ending");
  assert.equal(parsePlEvent(ev({ type: "pl.trial_expired", facts: TRIAL }))?.type, "pl.trial_expired");
  assert.equal(parsePlEvent(ev({ type: "pl.trial_ending", facts: {} })), null);
  assert.equal(parsePlEvent(ev({ type: "pl.trial_expired", facts: { trial_end: "not-a-date" } })), null);
  assert.equal(parsePlEvent(ev({ type: "pl.trial_expired", facts: { plan: "trial" } })), null);
  assert.equal(parsePlEvent(ev({ type: "pl.deal_won" })), null, "an unknown type is still refused (control: the allowlist was not opened up)");
  assert.deepEqual([...PL_EVENT_TYPES].sort(), ["pl.app_activated", "pl.first_call", "pl.line_created", "pl.plan_purchased", "pl.registration_changed", "pl.signup_started", "pl.trial_ending", "pl.trial_expired"]);
});

test("S-a over the signed WEBHOOK: all three return 200 processed (was 422); activity + bus event once; replay is a duplicate no-op", async () => {
  const st = store();
  const deps = { resolveEventsKey: async () => KEY, store: async () => st.s, emit: st.emit };
  const ts = now();
  const send = async (body: string) => handlePersonalLineWebhook(new Request("http://x/api", { method: "POST", body, headers: { "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": signIngress(KEY.key, ts, body) } }), ORG, deps);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["pl.signup_started", {}, "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d01"],
    ["pl.trial_ending", TRIAL, "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d02"],
    ["pl.trial_expired", TRIAL, "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d03"],
  ];
  let v = 0;
  for (const [type, facts, id] of cases) {
    const body = ev({ type, facts, event_id: id, version: ++v });
    const r = await send(body);
    assert.deepEqual([r.status, r.body.status, r.body.activity, r.body.emitted], [200, "processed", true, true], type);
    const dup = await send(body);
    assert.deepEqual([dup.status, dup.body.status], [200, "duplicate"], type);
  }
  assert.deepEqual(st.acts.map((a) => a.metadata.event_type), cases.map((c) => c[0]));
  assert.deepEqual(st.acts.map((a) => a.subject), ["Personal Line: sign-up started", "Personal Line: trial ending", "Personal Line: trial expired"]);
  assert.deepEqual(st.emitted.map((e) => e.type), cases.map((c) => c[0]));
  assert.equal(st.facts.get(`${ORG}|accA`)!.f.trial_end, TRIAL.trial_end, "trial_end merged as a fact (version-guarded)");
  // negative with positive twin: a bad signature on a NEW type is 401 and reaches nothing
  const before = st.emitted.length;
  const body = ev({ type: "pl.trial_ending", facts: TRIAL, event_id: "0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d09" });
  const bad = await handlePersonalLineWebhook(new Request("http://x/api", { method: "POST", body, headers: { "x-pl-sf-kid": "ev1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": signIngress("z".repeat(40), ts, body) } }), ORG, deps);
  assert.equal(bad.status, 401); assert.equal(st.emitted.length, before);
});

test("S-a projection: an older trial_ending cannot overwrite a newer trial_end; it stays on the timeline marked stale (journey is not probability)", async () => {
  const st = store();
  const newer = parsePlEvent(ev({ type: "pl.trial_expired", version: 9, event_id: "aaaaaaaa-1111-4111-8111-000000000001", facts: { trial_end: "2026-10-25T04:00:00Z" } }))!;
  const older = parsePlEvent(ev({ type: "pl.trial_ending", version: 3, event_id: "aaaaaaaa-1111-4111-8111-000000000002", facts: { trial_end: "2026-10-18T04:00:00Z" } }))!;
  assert.equal(((await processPlEvent(ORG, newer, st.s, st.emit)) as any).factsApplied, true);
  const r = (await processPlEvent(ORG, older, st.s, st.emit)) as any;
  assert.equal(r.factsApplied, false);
  assert.equal(st.facts.get(`${ORG}|accA`)!.f.trial_end, "2026-10-25T04:00:00Z");
  assert.match(st.acts[1].subject, /older update/);
});

test("S-a STRUCTURE: the event projection moves no deal and sets no probability; plan_purchased is defined but has no emitter in the fork", () => {
  const events = readFileSync(path.join(root, "src/lib/personal-line/events.ts"), "utf8");
  const code = events.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\bdeals\b|probability|moveDeal|\bstage\b/);
  assert.match(code, /"pl\.plan_purchased"/);                         // control: the scan reads the real file
  const types = readFileSync(path.join(root, "src/lib/events/event-types.ts"), "utf8");
  for (const t of PL_EVENT_TYPES) assert.match(types, new RegExp(`"${t.replace(".", "\\.")}"`));
  const emitters: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(f) && /emitSeldonEvent\(\s*["']pl\.plan_purchased/.test(readFileSync(f, "utf8"))) emitters.push(f); } };
  walk(path.join(root, "src"));
  assert.deepEqual(emitters, []);
});
