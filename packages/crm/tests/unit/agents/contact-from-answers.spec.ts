// EPIC 2026-10-04 -- public intake form -> contact fields (positive twins included).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { contactFromAnswers, emailFromAnswers } from "../../../src/lib/forms/contact-from-answers";

describe("contactFromAnswers", () => {
  test("fullName and phone (the shipped template keys) become first/last name and phone", () => {
    assert.deepEqual(contactFromAnswers({ fullName: "Pat Anne Lee", phone: " +1 767 555 0100 " }), {
      firstName: "Pat",
      lastName: "Anne Lee",
      phone: "+1 767 555 0100",
    });
  });
  test("API-lowercased fullname is recognized", () => {
    assert.deepEqual(contactFromAnswers({ fullname: "Pat Anne Lee" }), {
      firstName: "Pat",
      lastName: "Anne Lee",
      phone: null,
    });
    assert.equal(contactFromAnswers({ name: "Fallback Name", fullname: "Preferred Name" }).firstName, "Preferred");
  });
  test("the working full_name/email form remains intact", () => {
    assert.deepEqual(contactFromAnswers({ full_name: "Quinn Lee" }), {
      firstName: "Quinn",
      lastName: "Lee",
      phone: null,
    });
    assert.equal(emailFromAnswers({ email: "quinn@example.test" }), "quinn@example.test");
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

test("lead-qualification workEmail answers link the submission to a CRM contact", () => {
  assert.equal(emailFromAnswers({ workEmail: "  lead@example.test " }), "lead@example.test");
  assert.equal(emailFromAnswers({ work_email: "lead@example.test" }), "lead@example.test");
  assert.equal(emailFromAnswers({ workemail: "  lower@example.test " }), "lower@example.test");
  assert.equal(emailFromAnswers({ work_email: "alias@example.test", workemail: "preferred@example.test" }), "preferred@example.test");
  assert.equal(emailFromAnswers({ email: "lead@example.test", workEmail: "other@example.test" }), "lead@example.test");
  assert.equal(emailFromAnswers({ email: "first@example.test", workemail: "second@example.test" }), "first@example.test");
});

describe("wiring: submitPublicIntakeAction", () => {
  const src = readFileSync(path.resolve(__dirname, "../../../src/lib/forms/actions.ts"), "utf8");
  test("uses contactFromAnswers and no longer reads only data.name", () => {
    assert.match(src, /contactFromAnswers\(data\)/);
    assert.doesNotMatch(src, /firstName: String\(data\.name \?\? "New"\)/);
  });
});
