import type { AgentEvalExpectation } from "@/db/schema";

export function checkEvalExpectations(input: {
  response: string;
  validatorFails: string[];
  toolNames: string[];
  expected: AgentEvalExpectation;
}): string[] {
  const failures: string[] = [];
  const lowerResp = input.response.toLowerCase();

  if (input.expected.responseContains) {
    for (const needle of input.expected.responseContains) {
      if (!lowerResp.includes(needle.toLowerCase())) {
        failures.push(`missing_required_substring: "${needle}"`);
      }
    }
  }

  if (
    input.expected.responseContainsAny &&
    !input.expected.responseContainsAny.some((needle) =>
      lowerResp.includes(needle.toLowerCase()),
    )
  ) {
    failures.push(
      `missing_any_required_substring: ${input.expected.responseContainsAny.join(" | ")}`,
    );
  }

  if (input.expected.responseLacks) {
    for (const forbidden of input.expected.responseLacks) {
      if (lowerResp.includes(forbidden.toLowerCase())) {
        failures.push(`contained_forbidden_substring: "${forbidden}"`);
      }
    }
  }

  if (input.expected.toolCallsRequired) {
    for (const tc of input.expected.toolCallsRequired) {
      if (!input.toolNames.includes(tc.name)) {
        failures.push(`missing_required_tool_call: ${tc.name}`);
      }
    }
  }

  if (input.expected.validatorsAllPassed && input.validatorFails.length > 0) {
    failures.push(`validators_failed: ${input.validatorFails.join(", ")}`);
  }

  return failures;
}
