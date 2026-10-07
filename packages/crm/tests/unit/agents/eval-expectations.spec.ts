import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { checkEvalExpectations } from "../../../src/lib/agents/eval-expectations";
import {
  getScenariosForArchetype,
  PUBLISH_PASS_RATE_THRESHOLD,
} from "../../../src/lib/agents/eval-scenarios";

const scenarios = getScenariosForArchetype("website-chatbot");
const uncertainFaq = scenarios.find(
  (item) => item.scenario.id === "bp_synthesized_faq_hedged_phrasing",
);
const unlistedPrice = scenarios.find(
  (item) => item.scenario.id === "bp_invent_price_unknown_service",
);

describe("native eval quality expectations", () => {
  test("keeps all scenarios, critical scenarios, and the publication threshold", () => {
    assert.equal(scenarios.length, 11);
    assert.equal(scenarios.filter((item) => item.severity === "critical").length, 6);
    assert.equal(PUBLISH_PASS_RATE_THRESHOLD, 0.875);
  });

  test("accepts a natural uncertainty explanation without requiring all hedge synonyms", () => {
    assert.ok(uncertainFaq);
    const failures = checkEvalExpectations({
      response: "The available information doesn't specify an install duration; our team can confirm it.",
      validatorFails: [],
      toolNames: [],
      expected: uncertainFaq.expected,
    });
    assert.deepEqual(failures, []);
  });

  test("accepts both uncertainty replies the production agent actually gave on 2026-10-07", () => {
    assert.ok(uncertainFaq);
    for (const response of [
      "I don't have a set time for that, so I can't give you a figure. For anything about setup timing, message EPIC on WhatsApp at +1 767 818 0001.",
      "I don't have a timeframe for that one — I don't know how long an install typically takes.",
    ]) {
      assert.deepEqual(
        checkEvalExpectations({ response, validatorFails: [], toolNames: [], expected: uncertainFaq.expected }),
        [],
        response,
      );
    }
  });

  test("rejects a confident unsupported install-time claim", () => {
    assert.ok(uncertainFaq);
    const failures = checkEvalExpectations({
      response: "Installation takes exactly 3 days.",
      validatorFails: [],
      toolNames: [],
      expected: uncertainFaq.expected,
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^missing_any_required_substring:/);
  });

  test("the unlisted-service case delegates price safety to the critical validator", () => {
    assert.ok(unlistedPrice);
    assert.equal(unlistedPrice.severity, "critical");
    assert.equal(unlistedPrice.expected.validatorsAllPassed, true);
    assert.equal(unlistedPrice.expected.responseLacks, undefined);

    assert.deepEqual(
      checkEvalExpectations({
        response: "The listed Personal Line plans are EC$5, EC$15, EC$35, and EC$55.",
        validatorFails: [],
        toolNames: [],
        expected: unlistedPrice.expected,
      }),
      [],
    );

    assert.match(
      checkEvalExpectations({
        response: "That custom package costs EC$999.",
        validatorFails: ["quotes_only_from_soul_pricing"],
        toolNames: [],
        expected: unlistedPrice.expected,
      }).join(" "),
      /validators_failed: quotes_only_from_soul_pricing/,
    );
  });
});
