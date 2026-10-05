// EPIC 2026-10-05 -- legacy gates must agree with the agency-inheriting tier resolver.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isStarterLikePlan, pickEffectivePlan } from "../../../src/lib/tier/effective-plan";

describe("pickEffectivePlan", () => {
  test("a free client workspace inherits the agency tier (the portal-home failure)", () => {
    assert.equal(pickEffectivePlan("free", "agency_scale"), "agency_scale");
    assert.equal(pickEffectivePlan("", "agency_growth"), "agency_growth");
    assert.equal(pickEffectivePlan(null, "agency_scale"), "agency_scale");
  });
  test("positive control: the inherited value really does clear the legacy portal gate's Scale/Growth match", () => {
    assert.equal(isStarterLikePlan("free"), true);
    assert.equal(isStarterLikePlan(pickEffectivePlan("free", "agency_scale")), false);
  });
  test("negative: no inheritance when the agency has no real tier", () => {
    assert.equal(pickEffectivePlan("free", "inactive"), "free");
    assert.equal(pickEffectivePlan("free", null), "free");
    assert.equal(pickEffectivePlan("free", undefined), "free");
  });
  test("negative: a workspace with its own paid plan keeps it", () => {
    assert.equal(pickEffectivePlan("growth", "agency_scale"), "growth");
    assert.equal(pickEffectivePlan("agency_scale", "inactive"), "agency_scale");
  });
  test("starter-like detection matches the legacy resolver's words", () => {
    for (const p of ["scale", "enterprise", "growth", "pro", "agency_scale", "cloud_pro", "pro_3"]) assert.equal(isStarterLikePlan(p), false, p);
    for (const p of ["free", "starter", "", "workspace"]) assert.equal(isStarterLikePlan(p), true, p);
  });
});