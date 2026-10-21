// Routing HEALTH on the Calling service summary for staff-linked lines (owner ruling 2026-10-21): connection, calling eligibility and routing health are
// separate rows; health comes from a RECORDED, DATED EPIC-staff observation (Uplink cannot see the voice server), "verified" only after a recorded passing
// WhatsApp acceptance call, and the heading never says operational unless routing is verified. Fixtures mirror the measured 3742 and 0001 evidence
// (2026-10-21T08:47Z) with fictional workspace/number ids. Exercised through serviceView (the GET /service/state path) and the rendered card.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";

import { ServiceStatesCard } from "../../../src/app/(dashboard)/phone-whatsapp/service-states";
import { serviceView, type ServiceDeps, type ServiceView } from "../../../src/lib/phone-whatsapp/service/orchestrate";
import type { RoutingObservation } from "../../../src/lib/phone-whatsapp/service/routing-observations";
import type { LineEvidence } from "../../../src/lib/phone-whatsapp/types";

const WS = "aaaaaaaa-0000-4000-8000-0000000000a1";
const PHONE = "900000000000002";
const WABA = "900000000000001";
const DEST_3742 = "PJSIP/15550103742@pbx-fictional-a"; // shape of PJSIP/17678183742@818-epic-dm
const DEST_0001 = "PJSIP/36915550100001@AI-FICTIONAL"; // shape of PJSIP/36917678180001@AI-EPIC-DM
const OBS_AT = "2026-10-21T08:55:00.000Z";

type Obs = RoutingObservation;
const obs = (o: Partial<Obs>): Obs => ({ workspaceId: WS, phoneNumberId: PHONE, observedAt: OBS_AT, source: "Lane A trace", destination: DEST_3742, result: "configured_unverified", ...o });

function evidence(o: { dest?: string; answered?: boolean; magnusOk?: boolean; destActive?: boolean; didActive?: boolean; count?: number; callingStatus?: string; metaStatus?: string } = {}): LineEvidence {
  return {
    schema: "line-evidence/v1", wabaId: WABA, phoneNumberId: PHONE, observedAt: "2026-10-21T08:47:26.602Z",
    meta: { ok: true, displayNumber: "+1 555-010-3742", verifiedName: "Test", status: o.metaStatus ?? "CONNECTED", codeVerification: "EXPIRED", quality: "GREEN", nameStatus: "APPROVED", platformType: "CLOUD_API", messagingLimitTier: "TIER_2K", canReceiveCallSip: "AVAILABLE", extraFieldsError: null },
    calling: { ok: true, status: o.callingStatus ?? "ENABLED", sipStatus: "ENABLED", sipHost: "voice.example.test", sipPort: 5061, callIconVisibility: "DEFAULT" },
    magnus: o.magnusOk === false ? { ok: false, error: "voice platform did not answer" } : {
      ok: true, did: { activated: o.didActive ?? true, reserved: true }, destination: { value: o.dest ?? DEST_3742, kind: "pjsip_trunk", activated: o.destActive ?? true, count: o.count ?? 1 },
      // 3742's recent answered calls came over the phone network; they must never make the WhatsApp leg look verified.
      lastCalls: o.answered === false ? [] : [{ startedAt: "2026-10-20T20:26:36.000Z", durationSec: 175, answered: true, terminateCauseId: 1 }],
    },
  } as LineEvidence;
}

function deps(o: { ev?: LineEvidence; observations?: Obs[]; connection?: "active" | null; seen?: Array<[string, string]> } = {}): ServiceDeps {
  return {
    now: () => new Date("2026-10-21T12:00:00Z"),
    connectionStatus: async () => (o.connection === undefined ? null : o.connection),
    claimants: async () => [WS],
    line: async (w) => (w === WS ? { wabaId: WABA } : null),
    catalog: async () => [],
    agents: { exists: async () => false },
    ledger: { get: async () => null, begin: async () => true, recordStep: async () => {}, finish: async () => {} },
    evidence: async () => o.ev ?? evidence(),
    provisioner: () => { throw new Error("no provisioner on a read"); },
    callEvents: async () => [], appendCallEvent: async () => {},
    acceptance: async () => [], appendAcceptance: async () => {},
    // extra dependency: ignored by code that does not know it (so this file runs, and fails on assertions, on the base commit)
    routingObservations: (w: string, p: string) => { o.seen?.push([w, p]); return o.observations ?? []; },
  };
}

const card = (v: ServiceView) => renderToString(<ServiceStatesCard states={v.states} observedAt={v.observedAt} eligibility={v.eligibility} routingHealth={v.routingHealth} />);
const health = (v: ServiceView) => v.routingHealth;
const OPERATIONAL = /verified ready|verified as of|is operational|routing is healthy|\bhealthy\b/i;

describe("routing health for a staff-linked line (owner ruling 2026-10-21)", () => {
  test("3742-shaped, staff recorded the path configured: 'Configured; WhatsApp call not yet verified', NOT operational despite answered PSTN calls", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [obs({})] }));
    assert.equal(health(v)?.state, "configured_unverified");
    const html = card(v);
    assert.match(html, /Configured; WhatsApp call not yet verified \(observed 2026-10-21, Lane A trace\)/);
    assert.match(html, /WhatsApp calling is not verified/);
    assert.doesNotMatch(html, OPERATIONAL);
    assert.doesNotMatch(html, /answered/i);
  });

  test("after a RECORDED passing WhatsApp acceptance call for the current route: verified, and only then the heading says verified", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [obs({}), obs({ result: "whatsapp_call_passed", observedAt: "2026-10-21T10:00:00.000Z" })] }));
    assert.equal(health(v)?.state, "verified");
    const html = card(v);
    assert.match(html, /WhatsApp calling verified as of 2026-10-21 10:00 UTC/);
    assert.match(html, /worked in both directions \(observed 2026-10-21, Lane A trace\)/);
  });

  test("0001-shaped with the recorded faults: explicit 'Not operational: ...' with date and source; heading not operational", async () => {
    const faults = ["no WhatsApp endpoint on the voice server", "destination trunk AI-EPIC-DM unavailable"];
    const v = await serviceView(WS, PHONE, deps({ ev: evidence({ dest: DEST_0001, answered: false }), observations: [obs({ destination: DEST_0001, result: "faults", faults })] }));
    assert.equal(health(v)?.state, "faults");
    const html = card(v);
    assert.match(html, /Not operational: no WhatsApp endpoint on the voice server; destination trunk AI-EPIC-DM unavailable \(observed 2026-10-21, Lane A trace\)/);
    assert.match(html, /Calling for this number is not operational/);
    assert.doesNotMatch(html, OPERATIONAL);
  });

  test("nothing recorded: 'Not measured', never healthy, even though Meta checks pass and a call was answered", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [] }));
    assert.equal(health(v)?.state, "not_measured");
    const html = card(v);
    assert.match(html, /Not measured/);
    assert.doesNotMatch(html, OPERATIONAL);
  });

  test("a recorded observation for a DIFFERENT destination (route changed since) proves nothing: not measured", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [obs({ result: "whatsapp_call_passed", destination: DEST_0001 })] }));
    assert.equal(health(v)?.state, "not_measured");
    assert.doesNotMatch(card(v), OPERATIONAL);
  });

  test("observations are asked for with the SESSION workspace and this number only", async () => {
    const seen: Array<[string, string]> = [];
    await serviceView(WS, PHONE, deps({ seen }));
    assert.deepEqual(seen, [[WS, PHONE]]);
  });

  test("voice platform unreadable: unknown, says it could not be checked", async () => {
    const v = await serviceView(WS, PHONE, deps({ ev: evidence({ magnusOk: false }), observations: [obs({ result: "whatsapp_call_passed" })] }));
    assert.equal(health(v)?.state, "unknown");
    const html = card(v);
    assert.match(html, /Routing could not be checked right now/);
    assert.match(html, /Cannot be confirmed: routing could not be checked/); // a recorded call exists; it is not "absent"
    assert.doesNotMatch(html, /No passing WhatsApp acceptance call is recorded/);
  });

  test("voice platform shows no active destination: a live fault, whatever was recorded earlier", async () => {
    const v = await serviceView(WS, PHONE, deps({ ev: evidence({ destActive: false }), observations: [obs({ result: "whatsapp_call_passed" })] }));
    assert.equal(health(v)?.state, "faults");
    assert.doesNotMatch(card(v), OPERATIONAL);
  });

  test("connection, calling eligibility and routing are three separate rows, eligibility from the same Meta checks as the card", async () => {
    const html = card(await serviceView(WS, PHONE, deps({ observations: [obs({})] })));
    for (const l of ["Connection to Meta", "Calling eligibility", "Routing"]) assert.match(html, new RegExp(`${l}(<!-- -->)?:`));
    assert.match(html, /Eligible: all 6 checks pass/);
  });

  test("control: a failing Meta check shows on the eligibility row, and a recorded passing call then does NOT make the heading verified", async () => {
    const v = await serviceView(WS, PHONE, deps({ ev: evidence({ callingStatus: "DISABLED" }), observations: [obs({ result: "whatsapp_call_passed" })] }));
    const html = card(v);
    assert.match(html, /Not eligible yet/);
    assert.doesNotMatch(html, /verified as of/);
  });

  test("a FUTURE-dated passing call (after the clock) proves nothing: not verified", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [obs({ result: "whatsapp_call_passed", observedAt: "2099-01-01T00:00:00.000Z" })] }));
    assert.equal(health(v)?.state, "not_measured");
    assert.doesNotMatch(card(v), /verified as of/);
  });

  test("an observation time with an offset is shown in real UTC", async () => {
    const v = await serviceView(WS, PHONE, deps({ observations: [obs({ result: "whatsapp_call_passed", observedAt: "2026-10-21T04:00:00-04:00" })] }));
    assert.match(card(v), /verified as of 2026-10-21 08:00 UTC/);
  });

  test("a recorded passing call no longer applies after the destination is switched off: the acceptance row does not claim nothing was ever recorded", async () => {
    const html = card(await serviceView(WS, PHONE, deps({ ev: evidence({ destActive: false }), observations: [obs({ result: "whatsapp_call_passed" })] })));
    assert.match(html, /No passing WhatsApp acceptance call is recorded for the current route/);
    assert.doesNotMatch(html, /verified as of/);
  });

  test("inactive DID: live fault; two destination rows (ambiguous): not measured; never verified", async () => {
    const passed = [obs({ result: "whatsapp_call_passed" })];
    assert.equal(health(await serviceView(WS, PHONE, deps({ ev: evidence({ didActive: false }), observations: passed })))?.state, "faults");
    const amb = await serviceView(WS, PHONE, deps({ ev: evidence({ count: 2 }), observations: passed }));
    assert.equal(health(amb)?.state, "not_measured");
    assert.doesNotMatch(card(amb), /verified as of/);
  });

  test("Meta no longer reports CONNECTED: a recorded passing call does not make the heading verified", async () => {
    assert.doesNotMatch(card(await serviceView(WS, PHONE, deps({ ev: evidence({ metaStatus: "DISCONNECTED" }), observations: [obs({ result: "whatsapp_call_passed" })] }))), /verified as of/);
  });

  test("control: a self-serve line (active connect-flow record) keeps its existing routing row; no staff health is applied", async () => {
    const v = await serviceView(WS, PHONE, deps({ connection: "active", observations: [obs({ result: "whatsapp_call_passed" })] }));
    assert.equal(health(v) ?? null, null);
    assert.doesNotMatch(card(v), /verified as of/);
  });
});
