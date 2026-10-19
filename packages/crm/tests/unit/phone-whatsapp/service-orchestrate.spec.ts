// The use cases end to end over in-memory dependencies (SIMULATED evidence and provisioner; fictional ids): attach -> verified routing -> acceptance record, the
// recoverable failures, cross-workspace refusals, and acceptance turning HISTORICAL after a route change. Positive control in every refusal.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AttachLedgerRecord, AttachLedger, Provisioner } from "../../../src/lib/phone-whatsapp/service/attach";
import type { DestinationOption } from "../../../src/lib/phone-whatsapp/service/destinations";
import { attach, ingestCallEvent, recordAcceptance, serviceView, versionOf, type ServiceDeps, type StoredAttestation } from "../../../src/lib/phone-whatsapp/service/orchestrate";
import type { MetaCallEvent } from "../../../src/lib/phone-whatsapp/service/acceptance";
import type { LineEvidence } from "../../../src/lib/phone-whatsapp/types";

const WS_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const WS_B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const PHONE = "900000000000002";
const WABA = "900000000000001";
const D1: DestinationOption = { id: "d1", label: "Front desk", kind: "pbx_queue", target: { trunk: "pbx-a", ext: "900" }, workspaceId: WS_A, status: "active" };
const D2: DestinationOption = { id: "d2", label: "After hours", kind: "pbx_queue", target: { trunk: "pbx-a", ext: "901" }, workspaceId: WS_A, status: "active" };

function world(over: { connection?: ServiceDeps["connectionStatus"] extends (...a: never[]) => Promise<infer R> ? R : never; claimants?: string[]; evidenceDown?: boolean } = {}) {
  const t = {
    ledger: new Map<string, AttachLedgerRecord>(), events: [] as MetaCallEvent[], accept: [] as StoredAttestation[],
    routeTarget: null as string | null, didActive: false, cdrs: [] as Array<{ startedAt: string; durationSec: number; answered: boolean }>, provCalls: 0,
    now: new Date("2026-10-18T10:00:00Z"), claimants: over.claimants ?? [WS_A], destCount: 1,
  };
  const ledger: AttachLedger = {
    get: async (w, p) => t.ledger.get(`${w}|${p}`) ?? null,
    begin: async (a) => { const c = t.ledger.get(`${a.workspaceId}|${a.phoneNumberId}`); if (c?.status === "in_progress" && c.leaseUntil && new Date(c.leaseUntil) > a.now) return false; t.ledger.set(`${a.workspaceId}|${a.phoneNumberId}`, { idempotencyKey: a.idempotencyKey, destinationId: a.destinationId, steps: c?.steps ?? {}, status: "in_progress", leaseUntil: new Date(a.now.getTime() + a.leaseMs).toISOString() }); return true; },
    recordStep: async (a) => { t.ledger.get(`${a.workspaceId}|${a.phoneNumberId}`)!.steps[a.step] = a.rec; },
    finish: async (a) => { const r = t.ledger.get(`${a.workspaceId}|${a.phoneNumberId}`)!; r.status = a.status; r.leaseUntil = null; },
  };
  const prov: Provisioner = {
    ensureServiceAccount: async () => { t.provCalls++; return { ref: "acct-1", created: true }; },
    ensureDid: async () => { t.provCalls++; t.didActive = true; return { ref: "did-1", created: true }; },
    ensureDestination: async (a) => { t.provCalls++; t.routeTarget = "trunk" in a.target ? `${a.target.trunk}/${a.target.ext}` : `agent:${a.target.agentRef}`; return { ref: "route-1", created: true }; },
    readBack: async () => ({ didActive: t.didActive, destination: t.routeTarget ? { target: t.routeTarget, active: true } : null }),
  };
  const evidence = async (): Promise<LineEvidence | null> => {
    if (over.evidenceDown) return null;
    return {
      schema: "line-evidence/v1", wabaId: WABA, phoneNumberId: PHONE, observedAt: t.now.toISOString(),
      meta: { ok: true, displayNumber: "+1 555 010 0100", verifiedName: "Test", status: "CONNECTED", codeVerification: "VERIFIED", quality: "GREEN", nameStatus: "APPROVED", platformType: "CLOUD_API", messagingLimitTier: "TIER_250", canReceiveCallSip: "AVAILABLE", extraFieldsError: null },
      calling: { ok: true, status: "ENABLED", sipStatus: "ENABLED", sipHost: "voice.example.test", sipPort: 5061, callIconVisibility: "DEFAULT" },
      magnus: { ok: true, did: t.didActive ? { activated: true, reserved: true } : null, destination: t.routeTarget ? { value: t.routeTarget, kind: "x", activated: true, count: t.destCount } : null, lastCalls: t.cdrs.map((c) => ({ startedAt: c.startedAt, durationSec: c.durationSec, answered: c.answered, terminateCauseId: 1 })) },
    } as LineEvidence;
  };
  const deps: ServiceDeps = {
    now: () => t.now,
    connectionStatus: async () => over.connection ?? "active",
    claimants: async () => t.claimants,
    line: async (w) => (w === WS_A ? { wabaId: WABA } : null),
    catalog: async (w) => (w === WS_A ? [D1, D2] : []),
    agents: { exists: async () => false },
    ledger, evidence, provisioner: () => prov,
    callEvents: async () => t.events, appendCallEvent: async (_w, _p, e) => { t.events.push(e); },
    acceptance: async () => t.accept, appendAcceptance: async (_w, _p, a) => { t.accept.push(a); },
  };
  return { t, deps };
}
const admin = { userId: "user-admin", role: "admin" };
const callAt = (w: ReturnType<typeof world>, iso: string, seconds = 40) => { w.t.events.push({ callId: `call-${w.t.events.length + 1}`, phoneNumberId: PHONE, at: iso }); w.t.cdrs.push({ startedAt: iso, durationSec: seconds, answered: true }); };

async function setUp(w: ReturnType<typeof world>, dest = "d1") {
  const r = await attach(WS_A, PHONE, dest, w.deps); assert.equal(r.ok, true); w.t.now = new Date(w.t.now.getTime() + 60_000); return r;
}

describe("connected number -> destination -> attach -> verified routing -> acceptance (SIMULATED)", () => {
  test("positive control: the whole journey, with the four states moving separately and READY only at the end", async () => {
    const w = world();
    let v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.connection, v.states.setup, v.states.ready, v.states.next], ["connected", "not_started", false, "choose_destination_and_set_up"]);
    assert.deepEqual(v.selectable.map((d) => d.id), ["d1", "d2"]);
    await setUp(w);
    v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.setup, v.states.routing, v.states.acceptance, v.states.ready, v.states.next], ["set_up", "verified", "not_recorded", false, "make_acceptance_call"]);
    callAt(w, new Date(w.t.now.getTime() + 30_000).toISOString());
    w.t.now = new Date(w.t.now.getTime() + 120_000);
    v = await serviceView(WS_A, PHONE, w.deps);
    assert.equal(v.states.next, "confirm_acceptance"); assert.equal(v.states.ready, false);
    const r = await recordAcceptance(WS_A, PHONE, admin, true, w.deps);
    assert.deepEqual(r, { ok: true, state: "accepted" });
    v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.acceptance, v.states.ready, v.states.next, v.acceptance.current.length, v.acceptance.historical.length], ["accepted", true, "none", 1, 0]);
    assert.equal(w.t.accept[0].evidence.routedTarget, "pbx-a/900");
  });

  test("recoverable failure: the provisioner fails mid-way; the view says setup stopped and a retry continues (no second account/DID)", async () => {
    const w = world(); let fail = true;
    const orig = w.deps.provisioner;
    w.deps.provisioner = (a, b) => { const p = orig(a, b); return { ...p, ensureDid: async (x) => { if (fail) { fail = false; throw new Error("timeout"); } return p.ensureDid(x); } }; };
    const r1 = await attach(WS_A, PHONE, "d1", w.deps);
    assert.deepEqual([r1.ok, !r1.ok && r1.code, !r1.ok && r1.retriable], [false, "step_failed", true]);
    let v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.setup, v.states.next, v.states.ready], ["step_failed", "retry_setup", false]);
    const calls = w.t.provCalls;
    assert.equal((await attach(WS_A, PHONE, "d1", w.deps)).ok, true);
    assert.equal(w.t.provCalls - calls, 2, "only the DID and the destination ran again, not the account");
    v = await serviceView(WS_A, PHONE, w.deps);
    assert.equal(v.states.setup, "set_up");
  });

  test("evidence unavailable at attach time: nothing is sent to the provisioner and the user is told to retry (the number is never taken from the request)", async () => {
    const w = world({ evidenceDown: true });
    const r = await attach(WS_A, PHONE, "d1", w.deps);
    assert.deepEqual([r.ok, !r.ok && r.retriable, w.t.provCalls], [false, true, 0]);
  });

  test("a connection that is not active cannot be set up (twin: active can)", async () => {
    const w = world({ connection: "registered" });
    const r = await attach(WS_A, PHONE, "d1", w.deps);
    assert.deepEqual([r.ok, !r.ok && r.code, w.t.provCalls], [false, "not_connected", 0]);
  });
});

describe("acceptance capture", () => {
  test("only an owner/admin can record; a member is refused (twin: admin works)", async () => {
    const w = world(); await setUp(w); callAt(w, new Date(w.t.now.getTime() + 5_000).toISOString()); w.t.now = new Date(w.t.now.getTime() + 60_000);
    assert.deepEqual(await recordAcceptance(WS_A, PHONE, { userId: "u", role: "member" }, true, w.deps), { ok: false, code: "forbidden", missing: [] });
    assert.equal(w.t.accept.length, 0);
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, w.deps)).ok, true);
  });
  test("the stored evidence names the NEWEST call that has both a Meta event and a matching answered record (an older or unpaired call is not used)", async () => {
    const w = world(); await setUp(w);
    callAt(w, new Date(w.t.now.getTime() + 5_000).toISOString()); // older, paired
    w.t.events.push({ callId: "unpaired-event", phoneNumberId: PHONE, at: new Date(w.t.now.getTime() + 500_000).toISOString() }); // newest event, no record
    callAt(w, new Date(w.t.now.getTime() + 100_000).toISOString()); // newer, paired
    w.t.now = new Date(w.t.now.getTime() + 900_000);
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, w.deps)).ok, true);
    assert.equal(w.t.accept[0].evidence.callId, "call-3");
  });
  test("no call evidence = nothing recorded: the statement alone is refused and says what is missing", async () => {
    const w = world(); await setUp(w);
    const r = await recordAcceptance(WS_A, PHONE, admin, true, w.deps);
    assert.deepEqual([r.ok, !r.ok && r.code, w.t.accept.length], [false, "evidence_missing", 0]);
    assert.match(String(!r.ok && r.missing[0]), /call placed after routing/);
  });
  test("a call record without a Meta event, or a Meta event without an answered record, is not enough", async () => {
    const w = world(); await setUp(w); const at = new Date(w.t.now.getTime() + 5_000).toISOString();
    w.t.cdrs.push({ startedAt: at, durationSec: 40, answered: true }); // CDR only
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, w.deps)).ok, false);
    const x = world(); await setUp(x); x.t.events.push({ callId: "c", phoneNumberId: PHONE, at }); // Meta event only
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, x.deps)).ok, false);
  });
  test("a number held by another workspace (or two) cannot be accepted by this one", async () => {
    const w = world({ claimants: [WS_B] }); await setUp(w).catch(() => undefined);
    assert.deepEqual(await recordAcceptance(WS_A, PHONE, admin, true, w.deps), { ok: false, code: "not_your_number", missing: [] });
    const two = world({ claimants: [WS_A, WS_B] });
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, two.deps)).ok, false);
  });
  test("'the audio did not work' is recorded as a failure with its evidence (and never counts as acceptance)", async () => {
    const w = world(); await setUp(w); callAt(w, new Date(w.t.now.getTime() + 5_000).toISOString()); w.t.now = new Date(w.t.now.getTime() + 60_000);
    assert.deepEqual(await recordAcceptance(WS_A, PHONE, admin, false, w.deps), { ok: true, state: "failed" });
    const v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.acceptance, v.states.ready], ["failed", false]);
  });
});

describe("a later routing change makes earlier acceptance HISTORICAL", () => {
  async function accepted() {
    const w = world(); await setUp(w); callAt(w, new Date(w.t.now.getTime() + 5_000).toISOString()); w.t.now = new Date(w.t.now.getTime() + 60_000);
    assert.equal((await recordAcceptance(WS_A, PHONE, admin, true, w.deps)).ok, true);
    const v = await serviceView(WS_A, PHONE, w.deps); assert.equal(v.states.ready, true); // control: it WAS ready
    return w;
  }
  test("the voice platform route is changed after acceptance: not ready, routed to another destination, and the earlier acceptance is listed as historical", async () => {
    const w = await accepted();
    w.t.routeTarget = "pbx-elsewhere/777"; // staff or a PBX change outside this flow
    const v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.routing, v.states.acceptance, v.states.ready], ["routed_other_destination", "not_applicable", false]);
    assert.deepEqual([v.acceptance.current.length, v.acceptance.historical.length], [0, 1]);
    assert.match(v.acceptance.historical[0].why, /not currently verified|earlier route/);
  });
  test("the workspace's chosen destination changes (new version): the earlier statement is historical and a NEW call + statement is required", async () => {
    const w = await accepted();
    const rec = w.t.ledger.get(`${WS_A}|${PHONE}`)!; rec.destinationId = "d2"; w.t.routeTarget = "pbx-a/901"; // generation 2, attached and routed
    const v = await serviceView(WS_A, PHONE, w.deps);
    assert.deepEqual([v.states.routing, v.acceptance.current.length, v.acceptance.historical.length, v.states.ready], ["verified", 0, 1, false]);
    assert.match(v.acceptance.historical[0].why, /earlier route/);
    assert.ok(v.states.next === "make_acceptance_call" || v.states.next === "confirm_acceptance");
    assert.notEqual(versionOf(D1), versionOf(D2));
  });
  test("a call that happened BEFORE the new route was verified cannot be used to accept the new route", async () => {
    const w = await accepted();
    w.t.ledger.get(`${WS_A}|${PHONE}`)!.destinationId = "d2"; w.t.routeTarget = "pbx-a/901";
    w.t.ledger.get(`${WS_A}|${PHONE}`)!.steps.read_back = { done: true, at: new Date(w.t.now.getTime() + 600_000).toISOString() }; // re-verified later than every existing call
    const r = await recordAcceptance(WS_A, PHONE, admin, true, w.deps);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "evidence_missing"]);
  });
});

describe("call events from the BFF", () => {
  test("the workspace is derived from the number's verified binding; an unbound or contested number is dropped (twin: a bound one is stored once)", async () => {
    const w = world();
    assert.deepEqual(await ingestCallEvent(PHONE, "call-x", "2026-10-18T10:05:00Z", w.deps), { ok: true });
    assert.deepEqual(await ingestCallEvent(PHONE, "call-x", "2026-10-18T10:05:00Z", w.deps), { ok: true, reason: "duplicate_ignored" });
    assert.equal(w.t.events.length, 1);
    const none = world({ claimants: [] }); assert.deepEqual(await ingestCallEvent(PHONE, "c", "2026-10-18T10:05:00Z", none.deps), { ok: false, reason: "unbound_number" });
    const two = world({ claimants: [WS_A, WS_B] }); assert.deepEqual(await ingestCallEvent(PHONE, "c", "2026-10-18T10:05:00Z", two.deps), { ok: false, reason: "conflicting_binding" });
    assert.equal(none.t.events.length + two.t.events.length, 0);
    assert.equal((await ingestCallEvent(PHONE, "", "bad", w.deps)).ok, false);
  });
});

describe("routing verification needs exactly one destination row (Codex review)", () => {
  for (const count of [2, 5]) {
    test(`${count} destination rows whose first matches: never 'verified' and never ready; twin: exactly 1 row is verified`, async () => {
      const w = world(); await setUp(w);
      assert.equal((await serviceView(WS_A, PHONE, w.deps)).states.routing, "verified");
      w.t.destCount = count;
      const v = await serviceView(WS_A, PHONE, w.deps);
      assert.notEqual(v.states.routing, "verified");
      assert.equal(v.states.ready, false);
    });
  }
});
