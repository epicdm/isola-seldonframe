import assert from "node:assert/strict";
import test from "node:test";

import { buildLineView } from "../../../src/lib/phone-whatsapp/view-model";
import type { LineEvidence } from "../../../src/lib/phone-whatsapp/types";
import { LINK, NOW, evidence, ok } from "./fixtures";

const opts = { now: NOW, expectedSipHost: "voice.example.test", proofWindowDays: 30 };
const view = (e: LineEvidence) => buildLineView(LINK, ok(e), opts);

test("all evidence present and passing: eligible, destination configured, routing proven, last call with timestamp (positive control)", () => {
  const v = view(evidence());
  assert.equal(v.connection.tone, "ok");
  assert.equal(v.eligibility.tone, "ok");
  assert.match(v.eligibility.headline, /^Eligible: all 6 checks pass/);
  assert.equal(v.eligibility.checks.length, 6);
  assert.equal(v.destination.tone, "ok");
  assert.match(v.destination.headline, /PJSIP\/15550100001@pbx-trunk/);
  assert.equal(v.routing.tone, "ok");
  assert.match(v.routing.headline, /Configured; a recent call was answered/);
  assert.match(v.lastCall.headline, /2026-10-17 12:57:27 UTC/);
  assert.match(v.lastCall.headline, /answered, 3 s/);
  assert.equal(v.lastCall.observedAt, "2026-10-17T18:59:50.000Z");
});

test("CONNECTED with an EXPIRED code verification is still Connected, and the expired verification is shown in the detail (measured live)", () => {
  const e = evidence();
  if (!e.meta.ok) throw new Error("fixture");
  const v = view({ ...e, meta: { ...e.meta, codeVerification: "EXPIRED" } });
  assert.equal(v.connection.tone, "ok");
  assert.match(v.connection.detail, /code verification: EXPIRED/);
  const disc = view({ ...e, meta: { ...e.meta, status: "DISCONNECTED" } });
  assert.equal(disc.connection.tone, "attention"); // positive twin: a non-CONNECTED status is not ok
});

test("RULE: an 'active/CONNECTED' number label does NOT make it call-eligible when calling evidence is missing", () => {
  const v = view(evidence({ calling: { ok: false, error: "Meta HTTP 400: no settings" } }));
  assert.equal(v.connection.tone, "ok"); // the label is fine ...
  assert.notEqual(v.eligibility.tone, "ok"); // ... but eligibility is not shown as ok
  assert.equal(v.eligibility.tone, "unknown");
  assert.match(v.eligibility.checks.find((c) => c.name.includes("calling is enabled"))!.detail, /Meta HTTP 400: no settings/);
  assert.equal(v.routing.tone, "unknown");
});

test("RULE: CONNECTED but calling DISABLED is attention, never ok", () => {
  const e = evidence();
  if (!e.calling.ok) throw new Error("fixture");
  const v = view({ ...e, calling: { ...e.calling, status: "DISABLED" } });
  assert.equal(v.connection.tone, "ok");
  assert.equal(v.eligibility.tone, "attention");
  assert.match(v.eligibility.headline, /Not eligible yet: 1 of 6/);
});

test("low messaging tier, wrong platform and unavailable SIP health each fail their own check", () => {
  const e = evidence();
  if (!e.meta.ok) throw new Error("fixture");
  const v = view({ ...e, meta: { ...e.meta, messagingLimitTier: "TIER_250", platformType: "ON_PREMISE", canReceiveCallSip: "BLOCKED" } });
  const bad = v.eligibility.checks.filter((c) => c.tone === "attention").map((c) => c.name);
  assert.equal(bad.length, 3);
  assert.equal(v.eligibility.tone, "attention");
});

test("unreported extra Meta fields are unknown (never assumed fine); eligibility says it cannot confirm", () => {
  const e = evidence();
  if (!e.meta.ok) throw new Error("fixture");
  const v = view({ ...e, meta: { ...e.meta, platformType: null, messagingLimitTier: null, canReceiveCallSip: null, extraFieldsError: "(#100) field not available" } });
  assert.equal(v.eligibility.tone, "unknown");
  assert.match(v.eligibility.headline, /Cannot confirm eligibility: 3 of 6/);
  assert.match(v.eligibility.checks[1].detail, /field not available/);
});

test("RULE: failed Meta read -> every dependent fact is unknown and shows the actual error, never ok", () => {
  const v = view(evidence({ meta: { ok: false, error: "number is not on the linked WhatsApp business account" }, calling: { ok: false, error: "not read" } }));
  assert.equal(v.connection.tone, "unknown");
  assert.match(v.connection.detail, /not on the linked WhatsApp business account/);
  assert.equal(v.eligibility.tone, "unknown");
  assert.equal(v.displayNumber, null);
});

test("a number with no voice-platform entry or no destination is attention; a switched-off destination is attention", () => {
  const base = evidence();
  const noDid = view({ ...base, magnus: { ok: true, did: null, destination: null, lastCalls: [] } });
  assert.equal(noDid.destination.tone, "attention");
  assert.equal(noDid.routing.tone, "attention");
  assert.match(noDid.routing.detail, /no entry for this number/);
  const noDest = view({ ...base, magnus: { ok: true, did: { activated: true, reserved: true }, destination: null, lastCalls: [] } });
  assert.match(noDest.destination.headline, /no destination/);
  const off = view({ ...base, magnus: { ok: true, did: { activated: true, reserved: true }, destination: { value: "PJSIP/x@y", kind: "pjsip_trunk", activated: false, count: 1 }, lastCalls: [] } });
  assert.equal(off.destination.tone, "attention");
  assert.match(off.routing.detail, /switched off/);
});

test("RULE: complete configuration with NO answered call is 'configured, not proven' (unknown), never ok", () => {
  const e = evidence();
  if (!e.magnus.ok) throw new Error("fixture");
  const v = view({ ...e, magnus: { ...e.magnus, lastCalls: [] } });
  assert.equal(v.routing.tone, "unknown");
  assert.match(v.routing.headline, /Configured; no answered call on record/);
  assert.equal(v.lastCall.tone, "unknown");
  assert.match(v.lastCall.headline, /No call record found/);
});

test("an answered call older than the proof window does not prove routing", () => {
  const e = evidence();
  if (!e.magnus.ok) throw new Error("fixture");
  const v = view({ ...e, magnus: { ...e.magnus, lastCalls: [{ startedAt: "2026-08-01T10:00:00.000Z", durationSec: 60, answered: true, terminateCauseId: 1 }] } });
  assert.equal(v.routing.tone, "unknown");
});

test("SIP host that is not the expected voice host is a routing problem, not ok", () => {
  const e = evidence();
  if (!e.calling.ok) throw new Error("fixture");
  const v = view({ ...e, calling: { ...e.calling, sipHost: "voice-old.example.test" } });
  assert.equal(v.routing.tone, "attention");
  assert.match(v.routing.detail, /voice-old\.example\.test, not voice\.example\.test/);
});

test("failed call-record read is unknown with the error; an unanswered last call is attention with its timestamp", () => {
  const e = evidence();
  const failed = view({ ...e, magnus: { ok: false, error: "Magnus error: denied" } });
  assert.equal(failed.lastCall.tone, "unknown");
  assert.match(failed.lastCall.detail, /Magnus error: denied/);
  assert.equal(failed.routing.tone, "unknown");
  if (!e.magnus.ok) throw new Error("fixture");
  const missed = view({ ...e, magnus: { ...e.magnus, lastCalls: [{ startedAt: "2026-10-17T04:00:00.000Z", durationSec: 0, answered: false, terminateCauseId: 3 }] } });
  assert.equal(missed.lastCall.tone, "attention");
  assert.match(missed.lastCall.headline, /2026-10-17 04:00:00 UTC.*not answered/);
});

test("RULE: evidence service not configured or failing -> every fact unknown, with the reason, no observation time", () => {
  for (const r of [{ kind: "not_configured" as const }, { kind: "failed" as const, error: "the evidence service answered HTTP 502" }]) {
    const v = buildLineView(LINK, r, opts);
    for (const f of [v.connection, v.eligibility, v.destination, v.routing, v.lastCall]) {
      assert.equal(f.tone, "unknown");
      assert.equal(f.observedAt, null);
    }
    assert.match(v.connection.detail, r.kind === "failed" ? /HTTP 502/ : /not configured/);
    assert.equal(v.displayNumber, null);
  }
});
