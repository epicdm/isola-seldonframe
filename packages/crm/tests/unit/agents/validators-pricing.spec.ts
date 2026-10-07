import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALL_VALIDATORS } from "../../../src/lib/agents/validators";
import type { AgentBlueprint } from "../../../src/db/schema/agents";

const found = ALL_VALIDATORS.find(
  (validator) => validator.name === "quotes_only_from_soul_pricing",
);
if (!found) throw new Error("quotes_only_from_soul_pricing validator missing");
const pricing = found;

const blueprint: AgentBlueprint = {
  pricingFacts: [5, 15, 35, 55].map((amount) => ({
    label: `Personal Line ${amount}`,
    amount,
    currency: "XCD",
  })),
};

function run(response: string) {
  return pricing.run({
    response,
    userMessage: "How much does it cost?",
    blueprint,
    soul: null,
  });
}

describe("quotes_only_from_soul_pricing", () => {
  test("allows the approved Personal Line EC-dollar prices", () => {
    assert.equal(
      run("The plans are EC$5, EC$15, EC$35, and EC$55.").passed,
      true,
    );
  });

  test("rejects a price not present in the approved Personal Line facts", () => {
    assert.equal(run("The custom plan is EC$999.").passed, false);
  });
});
