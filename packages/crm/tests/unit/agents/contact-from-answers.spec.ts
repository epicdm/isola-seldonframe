// EPIC 2026-10-04 -- public intake form -> contact fields (positive twins included).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { contactFromAnswers } from "../../../src/lib/forms/contact-from-answers";

describe("contactFromAnswers", () => {
  test("fullName and phone (the shipped template keys) become first/last name and phone", () => {
    assert.deepEqual(contactFromAnswers({ fullName: "Pat Anne Lee", phone: " +1 767 555 0100 " }), {
      firstName: "Pat",
      lastName: "Anne Lee",
      phone: "+1 767 555 0100",
    });
  });
  test("control: the old key 'name' still works, and firstName/lastName keys work without a full name", () => {
    assert.equal(contactFromAnswers({ name: "Sam" }).firstName, "Sam");
    assert.deepEqual(contactFromAnswers({ firstName: "Ana", lastName: "Cruz" }), { firstName: "Ana", lastName: "Cruz", phone: null });
  });
  test("empty, missing and non-string answers yield nulls (never the string 'New' or 'undefined')", () => {
    for (const data of [{}, { fullName: "", phone: "  " }, { fullName: 42, phone: null }, { name: { x: 1 } }]) {
      assert.deepEqual(contactFromAnswers(data as Record<string, unknown>), { firstName: null, lastName: null, phone: null });
    }
  });
});

describe("wiring: submitPublicIntakeAction", () => {
  const src = readFileSync(path.resolve(__dirname, "../../../src/lib/forms/actions.ts"), "utf8");
  test("uses contactFromAnswers and no longer reads only data.name", () => {
    assert.match(src, /contactFromAnswers\(data\)/);
    assert.doesNotMatch(src, /firstName: String\(data\.name \?\? "New"\)/);
  });
});
