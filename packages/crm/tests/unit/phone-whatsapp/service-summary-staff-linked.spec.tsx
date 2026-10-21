// The "Calling service" summary for a number EPIC staff linked to the workspace (settings.phoneWhatsapp.lines) WITHOUT the self-serve connect flow, so there is
// no connections[<phone>] record and no attach ledger. Measured live 2026-10-21 on workspace 2a62ca68 (3742 and 0001): the detailed cards (Meta + Magnus
// evidence) said Connected / Eligible / Configured while the summary said "Not connected to Meta", "not set up yet" and "Calls go to a different destination
// than the one you chose" (nothing was ever chosen). The summary must read the SAME evidence as the cards, say "unknown" when it cannot, and expose no new
// write action. Fictional ids; the evidence shape mirrors the measured one. Every absence assertion has a positive control in the same file.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";

import { ServiceStatesCard } from "../../../src/app/(dashboard)/phone-whatsapp/service-states";
import type { AttachLedgerRecord } from "../../../src/lib/phone-whatsapp/service/attach";
import type { DestinationOption } from "../../../src/lib/phone-whatsapp/service/destinations";
import { attach, serviceView, type ServiceDeps } from "../../../src/lib/phone-whatsapp/service/orchestrate";
import { deriveServiceStates } from "../../../src/lib/phone-whatsapp/service/states";
import type { LineEvidence } from "../../../src/lib/phone-whatsapp/types";

const WS = "aaaaaaaa-0000-4000-8000-0000000000a1";
const PHONE = "900000000000002";
const WABA = "900000000000001";
const STAFF_ROUTE = "PJSIP/15550100100@pbx-fictional-a"; // the adapter's form; set by staff, not chosen on the page
const FIXED: DestinationOption = { id: "pbx-fictional-a/900", label: "Office queue", kind: "pbx_queue", target: { trunk: "pbx-fictional-a", ext: "900" }, workspaceId: WS, status: "active" };
const routedActive = { didActive: true, destinationActive: true, destinationTarget: "pbx-fictional-a/15550100100" };

const SETUP_ACTIONS = new Set(["choose_destination_and_set_up", "retry_setup"]); // the ServicePanel shows the setup form only for these
const ACCEPT_ACTIONS = new Set(["make_acceptance_call", "confirm_acceptance"]);

function evidence(o: { metaOk?: boolean; metaStatus?: string | null } = {}): LineEvidence {
  return {
    schema: "line-evidence/v1", wabaId: WABA, phoneNumberId: PHONE, observedAt: "2026-10-21T08:47:26.602Z",
    meta: o.metaOk === false ? { ok: false, error: "Meta did not answer" } : { ok: true, displayNumber: "+1 555-010-0100", verifiedName: "Test", status: o.metaStatus === undefined ? "CONNECTED" : o.metaStatus, codeVerification: "EXPIRED", quality: "GREEN", nameStatus: "APPROVED", platformType: "CLOUD_API", messagingLimitTier: "TIER_2K", canReceiveCallSip: "AVAILABLE", extraFieldsError: null },
    calling: { ok: true, status: "ENABLED", sipStatus: "ENABLED", sipHost: "voice.example.test", sipPort: 5061, callIconVisibility: "DEFAULT" },
    magnus: { ok: true, did: { activated: true, reserved: true }, destination: { value: STAFF_ROUTE, kind: "pjsip_trunk", activated: true, count: 1 }, lastCalls: [{ startedAt: "2026-10-20T20:26:36.000Z", durationSec: 175, answered: true, terminateCauseId: 1 }] },
  } as LineEvidence;
}

function deps(o: { connection?: "active" | null; ev?: LineEvidence | null; ledger?: AttachLedgerRecord | null } = {}): ServiceDeps & { provCalls: () => number } {
  let provCalls = 0;
  const noProv = async () => { provCalls++; throw new Error("provisioner must not be called"); };
  return {
    now: () => new Date("2026-10-21T09:00:00Z"),
    connectionStatus: async () => (o.connection === undefined ? null : o.connection),
    claimants: async () => [WS],
    line: async (w) => (w === WS ? { wabaId: WABA } : null),
    catalog: async () => [FIXED],
    agents: { exists: async () => false },
    ledger: { get: async () => o.ledger ?? null, begin: async () => { provCalls++; return true; }, recordStep: async () => {}, finish: async () => {} },
    evidence: async () => (o.ev === undefined ? evidence() : o.ev),
    provisioner: () => ({ ensureServiceAccount: noProv, ensureDid: noProv, ensureDestination: noProv, readBack: noProv }),
    callEvents: async () => [], appendCallEvent: async () => {},
    acceptance: async () => [], appendAcceptance: async () => {},
    provCalls: () => provCalls,
  };
}

describe("deriveServiceStates: a staff-linked line (no connect-flow record) reads Meta's own evidence", () => {
  const base = { connectionStatus: null, ledger: null, routing: routedActive, expectedTarget: null, acceptance: null } as const;

  test("Meta CONNECTED + routed by staff: connected (staff-linked), staff-managed setup, routed by staff; NOT 'not connected' / 'other destination'", () => {
    const s = deriveServiceStates({ ...base, staffLine: { metaStatus: "CONNECTED" } });
    assert.equal(s.connection, "linked_by_staff");
    assert.equal(s.setup, "staff_managed");
    assert.equal(s.routing, "routed_by_staff");
    assert.equal(s.next, "staff_managed");
    assert.equal(s.ready, false); // no acceptance on record: never "ready"
    assert.ok(!SETUP_ACTIONS.has(s.next) && !ACCEPT_ACTIONS.has(s.next), "no new write action is exposed");
  });

  test("Meta could not be read: connection is UNKNOWN, never 'not connected' (fail closed, says so)", () => {
    const s = deriveServiceStates({ ...base, staffLine: { metaStatus: null } });
    assert.equal(s.connection, "unknown");
    assert.notEqual(s.connection, "not_connected");
    assert.equal(s.next, "recheck");
    assert.ok(!SETUP_ACTIONS.has(s.next));
  });

  test("control: Meta reports a non-connected status -> not connected (the staff-line path is not 'always connected')", () => {
    assert.equal(deriveServiceStates({ ...base, staffLine: { metaStatus: "DISCONNECTED" } }).connection, "not_connected");
  });

  test("control: a connect-flow record still wins over the staff-line reading (existing behaviour unchanged)", () => {
    const s = deriveServiceStates({ ...base, connectionStatus: "active", staffLine: { metaStatus: "DISCONNECTED" } });
    assert.equal(s.connection, "connected");
    assert.equal(s.setup, "not_started");
    assert.equal(s.next, "choose_destination_and_set_up");
  });

  test("control: with no staffLine input the old mapping is unchanged (null record = not connected)", () => {
    assert.equal(deriveServiceStates({ ...base }).connection, "not_connected");
  });

  test("routing with NO chosen destination on a staff-linked line is never 'a different destination than the one you chose'", () => {
    assert.equal(deriveServiceStates({ ...base, staffLine: { metaStatus: "CONNECTED" } }).routing, "routed_by_staff");
    assert.equal(deriveServiceStates({ ...base, staffLine: { metaStatus: null } }).routing, "routed_by_staff");
  });

  test("staff-linked line whose route target could not be read: routing UNKNOWN, never 'routed' (fail closed)", () => {
    assert.equal(deriveServiceStates({ ...base, staffLine: { metaStatus: "CONNECTED" }, routing: { ...routedActive, destinationTarget: null } }).routing, "unknown");
  });

  test("control: the self-serve path (active record, nothing chosen) is unchanged by this fix and keeps its setup action", () => {
    const s = deriveServiceStates({ ...base, connectionStatus: "active" });
    assert.equal(s.routing, "routed_other_destination"); // pre-existing behaviour, deliberately not touched here
    assert.ok(SETUP_ACTIONS.has(s.next), "positive control for the action-membership check");
  });

  test("control: a chosen destination that differs from the route is still 'routed_other_destination'", () => {
    const attached: AttachLedgerRecord = { idempotencyKey: "k", destinationId: "d", steps: {}, status: "attached", leaseUntil: null };
    assert.equal(deriveServiceStates({ ...base, connectionStatus: "active", ledger: attached, expectedTarget: "pbx-fictional-a/900" }).routing, "routed_other_destination");
  });

  test("control: a ledger whose destination left the catalog (expectedTarget null) and an unreadable route target is NEVER verified", () => {
    const attached: AttachLedgerRecord = { idempotencyKey: "k", destinationId: "gone", steps: {}, status: "attached", leaseUntil: null };
    const s = deriveServiceStates({ ...base, connectionStatus: "active", ledger: attached, expectedTarget: null, routing: { ...routedActive, destinationTarget: null } });
    assert.notEqual(s.routing, "verified");
    assert.equal(s.routing, "routed_other_destination");
  });

  test("control: an inactive DID is still 'not routed' even with no chosen destination", () => {
    assert.equal(deriveServiceStates({ ...base, routing: { ...routedActive, didActive: false } }).routing, "not_routed");
  });
});

describe("serviceView (the GET /service/state path) for a staff-linked line", () => {
  test("measured shape: the summary agrees with the cards' evidence", async () => {
    const v = await serviceView(WS, PHONE, deps());
    assert.equal(v.states.connection, "linked_by_staff");
    assert.equal(v.states.routing, "routed_by_staff");
    assert.equal(v.states.next, "staff_managed");
    assert.equal(v.observedAt, "2026-10-21T08:47:26.602Z");
  });

  test("evidence service down: connection unknown (not 'not connected'), routing unknown", async () => {
    const v = await serviceView(WS, PHONE, deps({ ev: null }));
    assert.equal(v.states.connection, "unknown");
    assert.equal(v.states.routing, "unknown");
  });

  test("Meta block failed: connection unknown", async () => {
    assert.equal((await serviceView(WS, PHONE, deps({ ev: evidence({ metaOk: false }) }))).states.connection, "unknown");
  });

  test("control: a real connect-flow record (active) keeps the self-serve path and its setup step", async () => {
    const v = await serviceView(WS, PHONE, deps({ connection: "active" }));
    assert.equal(v.states.connection, "connected");
    assert.equal(v.states.next, "choose_destination_and_set_up");
  });

  test("positive control for the counter: an active connect-flow record DOES reach the ledger/provisioner", async () => {
    const d = deps({ connection: "active" });
    await attach(WS, PHONE, FIXED.id, d).catch(() => null);
    assert.ok(d.provCalls() > 0);
  });

  test("the write gate is untouched: attach for a staff-linked line is still refused and calls no provisioner", async () => {
    const d = deps();
    const r = await attach(WS, PHONE, FIXED.id, d);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "not_connected");
    assert.equal(d.provCalls(), 0);
  });
});

describe("<ServiceStatesCard> wording for a staff-linked line", () => {
  test("says connected and staff-managed; none of the three contradicting phrases", () => {
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: null, ledger: null, routing: routedActive, expectedTarget: null, acceptance: null, staffLine: { metaStatus: "CONNECTED" } })} />);
    assert.match(html, /Connected to Meta/);
    assert.match(html, /managed by EPIC staff/);
    assert.doesNotMatch(html, /Not connected to Meta/);
    assert.doesNotMatch(html, /not set up yet/);
    assert.doesNotMatch(html, /different destination than the one you chose/);
    assert.doesNotMatch(html, /verified ready/);
  });

  test("unknown connection says it could not be checked", () => {
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: null, ledger: null, routing: null, expectedTarget: null, acceptance: null, staffLine: { metaStatus: null } })} />);
    assert.match(html, /could not be checked/i);
    assert.doesNotMatch(html, /Not connected to Meta/);
  });

  test("positive control: the card still renders 'different destination than the one you chose' when a chosen destination differs", () => {
    const attached: AttachLedgerRecord = { idempotencyKey: "k", destinationId: "d", steps: {}, status: "attached", leaseUntil: null };
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: "active", ledger: attached, routing: routedActive, expectedTarget: "pbx-fictional-a/900", acceptance: null })} />);
    assert.match(html, /different destination than the one you chose/);
  });

  test("control: the same card still renders 'Not connected to Meta' when that is the truth", () => {
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: null, ledger: null, routing: null, expectedTarget: null, acceptance: null })} />);
    assert.match(html, /Not connected to Meta/);
  });
});
