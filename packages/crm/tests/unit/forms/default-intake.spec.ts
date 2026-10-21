// EPIC 2026-10-21 (Lane A) — default intake form selection rules (pure). Path coverage lives in
// tests/integration/intake-default-form.spec.ts and tests/unit/forms/intake-default-proxy-path.spec.ts.
// Run: node --import tsx --test tests/unit/forms/default-intake.spec.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import { isPublicIntakeEligible, readDefaultIntakeFormId, resolveDefaultIntakeForm } from "../../../src/lib/forms/default-intake";

const customer = { id: "c", slug: "personal-line-intake", isActive: true, settings: {} as Record<string, unknown> };
const staff = { id: "s", slug: "pl-staff-test-oct15", isActive: true, settings: { theme: "dark" } as Record<string, unknown> };
const pub = (f: typeof customer) => ({ ...f, settings: { ...f.settings, public: true } });

it("nothing marked public -> no default (the staff form is never picked)", () => {
  assert.equal(resolveDefaultIntakeForm({ forms: [customer, staff], defaultIntakeFormId: null }), null);
});

it("a single public form is the default (positive twin)", () => {
  assert.equal(resolveDefaultIntakeForm({ forms: [pub(customer), staff], defaultIntakeFormId: null })?.slug, "personal-line-intake");
});

it("an explicit default must be public and active; otherwise it is ignored", () => {
  assert.equal(resolveDefaultIntakeForm({ forms: [customer, staff], defaultIntakeFormId: "s" }), null);
  assert.equal(resolveDefaultIntakeForm({ forms: [pub(customer), { ...pub(staff), isActive: false }], defaultIntakeFormId: "s" })?.slug, "personal-line-intake");
  assert.equal(resolveDefaultIntakeForm({ forms: [pub(customer), pub(staff)], defaultIntakeFormId: "s" })?.slug, "pl-staff-test-oct15");
});

it("two public forms and no explicit default -> no guess", () => {
  assert.equal(resolveDefaultIntakeForm({ forms: [pub(customer), pub(staff)], defaultIntakeFormId: null }), null);
});

it("the platform-seeded 'intake' slug stays eligible (keeps today's /intake for those workspaces)", () => {
  const legacy = { id: "l", slug: "intake", isActive: true, settings: { submitLabel: "Send" } };
  assert.equal(isPublicIntakeEligible(legacy), true);
  assert.equal(isPublicIntakeEligible(staff), false);
  assert.equal(resolveDefaultIntakeForm({ forms: [legacy, staff], defaultIntakeFormId: null })?.slug, "intake");
  assert.equal(resolveDefaultIntakeForm({ forms: [legacy, pub(customer)], defaultIntakeFormId: "c" })?.slug, "personal-line-intake");
});

it("reads the org setting defensively", () => {
  assert.equal(readDefaultIntakeFormId({ defaultIntakeFormId: " c " }), "c");
  assert.equal(readDefaultIntakeFormId({ defaultIntakeFormId: 7 }), null);
  assert.equal(readDefaultIntakeFormId(null), null);
});
