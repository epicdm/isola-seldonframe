import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBlueprint } from "@/db/schema/agents";
import { runValidators } from "./validators.ts";

const blueprint: AgentBlueprint = {};

function piiResult(response: string) {
  const { results } = runValidators({
    response,
    userMessage: "How can I contact support?",
    blueprint,
    soul: { contact: { phone: "767-818-0001" } },
  });
  return results.find((result) => result.name === "no_pii_leak");
}

test("the configured support number is allowed with its country code", () => {
  assert.deepEqual(piiResult("Call us at +1 (767) 818-0001."), {
    name: "no_pii_leak",
    passed: true,
  });
});

test("a different customer's phone number remains blocked", () => {
  assert.equal(
    piiResult("You can also reach Pat at 767-555-0142.")?.passed,
    false,
  );
});

