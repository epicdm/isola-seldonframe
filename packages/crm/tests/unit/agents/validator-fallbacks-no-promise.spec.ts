import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  composeCorrectionPrompt,
  getFallbackEntry,
  selectFinalFallback,
} from "../../../src/lib/agents/fallbacks";

const VALIDATORS = [
  "quotes_only_from_soul_pricing",
  "no_prompt_injection_echo",
  "no_pii_leak",
  "no_avoid_words",
  "response_length_under_cap",
  "no_hallucinated_state_change",
];

// A promise of future contact the platform cannot keep. The reply text and the
// regeneration instruction (which steers the model) must both avoid it.
const PROMISE =
  /follow(?:ing)?[ -]?up|someone (?:from|will|can)|get back to you|look into that|reach out to you|call you|contact you|let me have|i'll have/i;

describe("validator fallbacks make no unsupported follow-up promise", () => {
  test("every final fallback and the generic fallback are free of promises", () => {
    for (const name of VALIDATORS) {
      const entry = getFallbackEntry(name);
      assert.ok(entry, `missing fallback entry for ${name}`);
      assert.doesNotMatch(entry.finalFallback, PROMISE, `${name} finalFallback`);
    }
    assert.doesNotMatch(selectFinalFallback([]), PROMISE, "generic fallback");
    assert.doesNotMatch(selectFinalFallback(["unknown_validator"]), PROMISE, "unknown validator");
  });

  test("the pricing correction prompt forbids promising contact instead of suggesting it", () => {
    const entry = getFallbackEntry("quotes_only_from_soul_pricing");
    assert.ok(entry);
    assert.match(entry.correction, /Do NOT promise a callback, a follow-up/);
    assert.doesNotMatch(entry.correction.replace(/Do NOT promise[^.]*\./, ""), PROMISE);
    const composed = composeCorrectionPrompt(["quotes_only_from_soul_pricing"]);
    assert.doesNotMatch(composed.replace(/Do NOT promise[^.]*\./, ""), PROMISE);
  });

  test("positive control: the promise pattern does catch the old v4.37 text", () => {
    assert.match("I'd like to give you an accurate quote — I'll have someone from the team follow up.", PROMISE);
    assert.match("Let me look into that for you.", PROMISE);
  });

  test("the pricing fallback is still selected for a pricing failure, ahead of lower-priority ones", () => {
    assert.equal(
      selectFinalFallback(["quotes_only_from_soul_pricing", "no_avoid_words"]),
      getFallbackEntry("quotes_only_from_soul_pricing")!.finalFallback,
    );
  });
});

describe("embed.js route resolves the requested agent, not an arbitrary one of the org", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/embed.js/route.ts"),
    "utf8",
  );

  test("the lookup filters on BOTH the org slug and the agent slug", () => {
    assert.match(
      source,
      /\.where\(\s*and\(\s*eq\(organizations\.slug, orgSlugPart\),\s*eq\(agents\.slug, agentSlugPart\),\s*\),?\s*\)/,
    );
    assert.doesNotMatch(source, /\.where\(eq\(organizations\.slug, orgSlugPart\)\)/);
  });

  test("it still returns a no-op script (not a 404) for a missing or inactive agent", () => {
    assert.match(source, /agent not live or not found/);
    assert.match(source, /\["live", "test"\]\.includes\(agentRow\.status\)/);
  });
});
