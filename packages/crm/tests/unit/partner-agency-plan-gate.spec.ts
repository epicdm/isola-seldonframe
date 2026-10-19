// Agency registration plan gate. Positive controls (values that MUST unlock) sit beside the negatives (values that MUST NOT),
// so a gate that accepts everything or nothing cannot pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planUnlocksAgency } from "../../src/lib/partner-agencies/plan-gate";

test("every agency-family tier unlocks (the ids the Stripe webhook actually writes)", () => {
  for (const p of ["agency_starter", "agency_growth", "agency_scale", "agency"]) {
    assert.equal(planUnlocksAgency(p), true, p);
  }
});

test("legacy 'scale' values keep working (no regression for existing rows)", () => {
  for (const p of ["scale", "Scale", "SCALE", "  scale "]) assert.equal(planUnlocksAgency(p), true, p);
});

test("non-agency plans do NOT unlock", () => {
  for (const p of ["free", "inactive", "builder", "managed", "workspace", "", null, undefined, "nonsense"]) {
    assert.equal(planUnlocksAgency(p as string | null | undefined), false, String(p));
  }
});

test('legacy "pro"-family values do NOT unlock (signup paths write plan "pro" on ordinary workspaces)', () => {
  for (const p of ["pro", "pro_3", "cloud_pro", "cloud_agency", "self_service", "growth", "starter"]) {
    assert.equal(planUnlocksAgency(p), false, p);
  }
});
