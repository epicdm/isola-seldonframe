// EPIC 2026-10-05 -- a Dominica customer resolves to America/Dominica, and existing inference is untouched.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { inferTimezone, resolveStateCode } from "../../../src/lib/workspace/infer-timezone";

describe("inferTimezone: Dominica", () => {
  test("country name, city and combined forms all resolve to America/Dominica", () => {
    assert.equal(inferTimezone("Dominica"), "America/Dominica");
    assert.equal(inferTimezone("Roseau"), "America/Dominica");
    assert.equal(inferTimezone("Roseau, Dominica"), "America/Dominica");
    assert.equal(inferTimezone("Dominica", "Roseau", "Roseau, Dominica", "Personal Line customer"), "America/Dominica");
  });
  test("the order the workspace builder uses (state, city, 'city, state', description) works", () => {
    assert.equal(inferTimezone("Dominica", "Roseau", "Roseau, Dominica", "a Dominica phone number"), "America/Dominica");
  });
  test("positive controls: existing US and Canada inference is unchanged", () => {
    assert.equal(inferTimezone("NY"), "America/New_York");
    assert.equal(inferTimezone("San Diego, CA"), "America/Los_Angeles");
    assert.equal(inferTimezone("Toronto, ON"), "America/Toronto");
  });
  test("negative controls: 'DM' (direct message) in free text is NOT read as a place, and no place still returns null", () => {
    assert.equal(inferTimezone("send us a DM on WhatsApp"), null);
    assert.equal(resolveStateCode("DM"), null);
    assert.equal(inferTimezone("Globally distributed"), null);
  });
});
