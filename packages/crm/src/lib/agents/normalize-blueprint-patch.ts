/** Accepts the snake_case field exposed by the agent tool API, while storing the typed camelCase blueprint shape. */
export function normalizeAgentBlueprintPatch(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const patch = { ...input };
  if (Object.hasOwn(patch, "pricing_facts")) {
    if (!Object.hasOwn(patch, "pricingFacts")) patch.pricingFacts = patch.pricing_facts;
    delete patch.pricing_facts;
  }
  return patch;
}
