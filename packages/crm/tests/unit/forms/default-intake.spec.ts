// EPIC 2026-10-21 (Lane A) — default intake form selection rules and data-island binding (pure). Path coverage:
// tests/integration/intake-default-form.spec.ts and tests/unit/forms/intake-default-proxy-path.spec.ts.
// Run: node --import tsx --test tests/unit/forms/default-intake.spec.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import { bindIntakeDataIslandFormSlug, isPublicIntakeEligible, readDefaultIntakeFormId, resolveDefaultIntakeForm } from "../../../src/lib/forms/default-intake";

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

it("a slug is not consent: a form named 'intake' is eligible only when marked public", () => {
  const named = { id: "l", slug: "intake", isActive: true, settings: { submitLabel: "Send" } as Record<string, unknown> };
  assert.equal(isPublicIntakeEligible(named), false);
  assert.equal(isPublicIntakeEligible({ ...named, settings: { public: false } }), false);
  assert.equal(resolveDefaultIntakeForm({ forms: [named, staff], defaultIntakeFormId: null }), null);
  assert.equal(resolveDefaultIntakeForm({ forms: [{ ...named, settings: { public: true } }, staff], defaultIntakeFormId: null })?.slug, "intake");
});

it("reads the org setting defensively", () => {
  assert.equal(readDefaultIntakeFormId({ defaultIntakeFormId: " c " }), "c");
  assert.equal(readDefaultIntakeFormId({ defaultIntakeFormId: 7 }), null);
  assert.equal(readDefaultIntakeFormId(null), null);
});

it("binds the pre-rendered data island to the resolved slug; keeps other fields; stays script-safe", () => {
  const island = JSON.stringify({ orgSlug: "ws", formSlug: "intake", label: "a</script>b" }).replace(/</g, "\\u003c");
  const html = `<div>x</div><script type="application/json" id="sf-intake-data">${island}</script><script>run()</script>`;
  const bound = bindIntakeDataIslandFormSlug(html, "personal-line-intake");
  assert.ok(bound);
  const json = /id="sf-intake-data">([\s\S]*?)<\/script>/.exec(bound)![1];
  assert.deepEqual(JSON.parse(json), { orgSlug: "ws", formSlug: "personal-line-intake", label: "a</script>b" });
  assert.equal(json.includes("<"), false);
  assert.ok(bound.startsWith("<div>x</div>") && bound.endsWith("<script>run()</script>"));
});

it("no parseable island -> null (caller fails closed)", () => {
  assert.equal(bindIntakeDataIslandFormSlug("<div>no island</div>", "x"), null);
  assert.equal(bindIntakeDataIslandFormSlug('<script type="application/json" id="sf-intake-data">{bad</script>', "x"), null);
});
