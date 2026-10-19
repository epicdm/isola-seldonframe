import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentBlueprintPatch } from "../../../src/lib/agents/normalize-blueprint-patch";

test("snake_case pricing_facts is persisted as the typed pricingFacts property", () => {
  const facts = [{ label: "Personal Line", amount: 10, currency: "XCD" }];
  assert.deepEqual(normalizeAgentBlueprintPatch({ pricing_facts: facts, greeting: "Hello" }), {
    pricingFacts: facts,
    greeting: "Hello",
  });
});

test("camelCase pricingFacts is preserved and wins if both spellings are supplied", () => {
  const canonical = [{ label: "Canonical", amount: 12, currency: "XCD" }];
  const alias = [{ label: "Alias", amount: 99, currency: "USD" }];
  assert.deepEqual(normalizeAgentBlueprintPatch({ pricingFacts: canonical, pricing_facts: alias }), {
    pricingFacts: canonical,
  });
});

test("unrelated blueprint patch fields pass through unchanged", () => {
  assert.deepEqual(normalizeAgentBlueprintPatch({ faq: [{ q: "Q", a: "A" }] }), {
    faq: [{ q: "Q", a: "A" }],
  });
});
