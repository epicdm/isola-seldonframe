import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BlueprintPatchSchema,
  CUSTOM_SKILL_MD_MAX,
  mergeAgentBlueprintPatch,
} from "../../../src/lib/agents/blueprint-patch";

const blueprint = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "pl-concierge-v28-blueprint.json"),
    "utf8",
  ),
) as Record<string, unknown> & {
  greeting: string;
  customSkillMd: string;
  capabilities: string[];
  faq: Array<Record<string, unknown>>;
  pricingFacts: Array<Record<string, unknown>>;
};

test("Settings greeting edit accepts the full installed instructions and preserves unrelated blueprint fields", () => {
  assert.equal(blueprint.customSkillMd.length, 13_544);
  const patch = {
    greeting: `${blueprint.greeting} [routine edit]`,
    capabilities: blueprint.capabilities,
    faq: blueprint.faq,
    pricingFacts: blueprint.pricingFacts,
    customSkillMd: blueprint.customSkillMd.trim(),
  };

  const parsed = BlueprintPatchSchema.safeParse(patch);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) return;

  const saved = mergeAgentBlueprintPatch(blueprint, parsed.data);
  assert.equal(saved.greeting, patch.greeting);
  for (const [key, value] of Object.entries(blueprint)) {
    if (key !== "greeting") assert.deepEqual(saved[key], value, `${key} changed`);
  }
});

test("Settings save rejects over-limit and unknown input", () => {
  const overLimit = BlueprintPatchSchema.safeParse({
    greeting: "valid",
    customSkillMd: "x".repeat(CUSTOM_SKILL_MD_MAX + 1),
  });
  assert.equal(overLimit.success, false);

  const unknownField = BlueprintPatchSchema.safeParse({
    greeting: "valid",
    injected: true,
  });
  assert.equal(unknownField.success, false);
});
