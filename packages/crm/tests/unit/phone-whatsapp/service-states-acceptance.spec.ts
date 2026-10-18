// Four separate states and the acceptance evidence rules, with fictional facts. Positive control in every refusal.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateAcceptance, type AcceptanceInput } from "../../../src/lib/phone-whatsapp/service/acceptance";
import type { AttachLedgerRecord } from "../../../src/lib/phone-whatsapp/service/attach";
import { deriveServiceStates } from "../../../src/lib/phone-whatsapp/service/states";

const WS = "aaaaaaaa-0000-4000-8000-0000000000a1";
const PHONE = "900000000000002";
const T0 = "2026-10-18T10:00:00.000Z"; // routing verified
const T1 = "2026-10-18T10:05:00.000Z"; // the call
const T2 = "2026-10-18T10:06:00.000Z"; // attestation
const base = (): AcceptanceInput => ({
  workspaceId: WS, phoneNumberId: PHONE, expectedTarget: "pbx-fictional-a/900", destinationVersion: "v1",
  routing: { didActive: true, destinationActive: true, destinationTarget: "pbx-fictional-a/900", observedAt: T0 },
  metaEvents: [{ callId: "call-1", phoneNumberId: PHONE, at: T1 }],
  cdrs: [{ answered: true, billedSeconds: 42, startedAt: T1, calledNumberMatchesLine: true }],
  attestations: [{ userId: "u1", role: "admin", workspaceId: WS, at: T2, twoWayAudio: true, destinationVersion: "v1" }],
});
const st = (i: AcceptanceInput) => evaluateAcceptance(i).state;

describe("evaluateAcceptance", () => {
  test("positive control: routing verified + Meta call event + matching answered CDR + admin statement after the call = accepted", () => {
    assert.deepEqual(evaluateAcceptance(base()), { state: "accepted", missing: [] });
  });
  test("a CDR alone is NOT acceptance (no Meta event, no statement)", () => {
    const i = base(); i.metaEvents = []; i.attestations = [];
    assert.equal(st(i), "not_recorded");
  });
  test("Meta event + CDR without the human statement is 'call seen, unconfirmed'", () => {
    const i = base(); i.attestations = [];
    assert.equal(st(i), "call_seen_unconfirmed");
  });
  test("a short, unanswered, other-number or far-away CDR does not pair with the Meta event", () => {
    for (const patch of [{ billedSeconds: 3 }, { answered: false }, { calledNumberMatchesLine: false }, { startedAt: "2026-10-18T11:30:00.000Z" }]) {
      const i = base(); i.cdrs = [{ ...i.cdrs[0], ...patch }];
      assert.equal(st(i), "call_seen_unconfirmed", JSON.stringify(patch));
    }
  });
  test("a Meta event for ANOTHER line, or from before routing was verified, does not count", () => {
    const i = base(); i.metaEvents = [{ callId: "x", phoneNumberId: "900000000000099", at: T1 }];
    assert.equal(st(i), "not_recorded");
    const j = base(); j.metaEvents = [{ callId: "y", phoneNumberId: PHONE, at: "2026-10-18T09:00:00.000Z" }];
    assert.equal(st(j), "not_recorded");
  });
  test("the statement must come from an owner/admin of THIS workspace, after the call, for the CURRENT destination", () => {
    for (const patch of [{ role: "member" }, { workspaceId: "bbbbbbbb-0000-4000-8000-0000000000b2" }, { at: "2026-10-18T10:04:00.000Z" }, { destinationVersion: "v0" }]) {
      const i = base(); i.attestations = [{ ...i.attestations[0], ...patch }];
      assert.equal(st(i), "call_seen_unconfirmed", JSON.stringify(patch));
    }
  });
  test("an admin saying the audio failed is 'failed', not accepted; a later success overrides nothing automatically (new call needed)", () => {
    const i = base(); i.attestations = [{ ...i.attestations[0], twoWayAudio: false }];
    assert.equal(st(i), "failed");
  });
  test("routing not verified (inactive, or pointing somewhere else, or unknown) blocks acceptance whatever else is true", () => {
    for (const routing of [null, { didActive: false, destinationActive: true, destinationTarget: "pbx-fictional-a/900", observedAt: T0 }, { didActive: true, destinationActive: true, destinationTarget: "other/1", observedAt: T0 }]) {
      const i = base(); i.routing = routing;
      assert.equal(st(i), "routing_not_verified");
    }
  });
  test("changing the destination invalidates earlier acceptance (statement bound to the old version)", () => {
    const i = base(); i.destinationVersion = "v2";
    assert.equal(st(i), "call_seen_unconfirmed");
  });
});

describe("deriveServiceStates", () => {
  const attached: AttachLedgerRecord = { idempotencyKey: "k", destinationId: "d", steps: {}, status: "attached", leaseUntil: null };
  const routed = { didActive: true, destinationActive: true, destinationTarget: "pbx-fictional-a/900" };
  const all = (o: Partial<Parameters<typeof deriveServiceStates>[0]> = {}) =>
    deriveServiceStates({ connectionStatus: "active", ledger: attached, routing: routed, expectedTarget: "pbx-fictional-a/900", acceptance: "accepted", ...o });

  test("positive control: all four good = ready, nothing next", () => {
    assert.deepEqual(all(), { connection: "connected", setup: "set_up", routing: "verified", acceptance: "accepted", ready: true, next: "none" });
  });
  test("CONNECTED TO META DOES NOT IMPLY SERVICE READY: connected with no setup is not ready and the next step is to choose a destination", () => {
    const s = all({ ledger: null, routing: null, acceptance: null });
    assert.deepEqual([s.connection, s.setup, s.ready, s.next], ["connected", "not_started", false, "choose_destination_and_set_up"]);
  });
  test("each earlier state blocks 'ready' even when the later ones look fine", () => {
    assert.equal(all({ connectionStatus: "registered" }).ready, false);
    assert.equal(all({ ledger: { ...attached, status: "step_failed" } }).ready, false);
    assert.equal(all({ routing: { ...routed, didActive: false } }).ready, false);
    assert.equal(all({ acceptance: "call_seen_unconfirmed" }).ready, false);
  });
  test("adapter unavailable is 'unknown', never 'not routed'", () => {
    assert.equal(all({ routing: null }).routing, "unknown");
    assert.equal(all({ routing: { ...routed, didActive: false } }).routing, "not_routed");
  });
  test("routed to a different destination than requested is its own state", () => {
    assert.equal(all({ routing: { ...routed, destinationTarget: "elsewhere/1" } }).routing, "routed_other_destination");
  });
  test("the next step is the EARLIEST state that is not good", () => {
    assert.equal(all({ connectionStatus: null }).next, "connect");
    assert.equal(all({ connectionStatus: "registering" }).next, "resolve_connection");
    assert.equal(all({ ledger: { ...attached, status: "step_failed" } }).next, "retry_setup");
    assert.equal(all({ ledger: { ...attached, status: "needs_review" } }).next, "staff_review_setup");
    assert.equal(all({ routing: null }).next, "wait_for_routing");
    assert.equal(all({ acceptance: "not_recorded" }).next, "make_acceptance_call");
    assert.equal(all({ acceptance: "call_seen_unconfirmed" }).next, "confirm_acceptance");
  });
  test("acceptance is not applicable until setup and routing are good", () => {
    assert.equal(all({ ledger: null }).acceptance, "not_applicable");
    assert.equal(all({ routing: null }).acceptance, "not_applicable");
  });
});
