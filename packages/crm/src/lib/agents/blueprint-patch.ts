import { z } from "zod";
import { connectorBindingsSchema } from "./mcp/connectors";
import { CUSTOM_SKILL_MD_MAX } from "./blueprint-patch-limits";

export { CUSTOM_SKILL_MD_MAX } from "./blueprint-patch-limits";

const FaqRow = z.object({
  q: z.string().min(1),
  a: z.string().min(1),
  source: z.enum(["extracted", "synthesized", "operator"]).optional(),
  sourceUrl: z.string().url().optional(),
  synthesizedAt: z.string().optional(),
  synthesizedFromSoulVersion: z.number().optional(),
});

const PricingFactRow = z.object({
  label: z.string().min(1),
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(8),
});

export const BlueprintPatchSchema = z
  .object({
    greeting: z.string().max(2000).optional(),
    capabilities: z.array(z.string()).optional(),
    faq: z.array(FaqRow).optional(),
    pricingFacts: z.array(PricingFactRow).optional(),
    toneOverrides: z
      .object({
        warmth: z.number().min(0).max(1).optional(),
        formality: z.number().min(0).max(1).optional(),
      })
      .optional(),
    // Empty string clears the override. Keep this bounded to avoid unbounded prompts.
    customSkillMd: z.string().max(CUSTOM_SKILL_MD_MAX).optional(),
    connectors: connectorBindingsSchema.optional(),
  })
  .strict();

/** The Settings save path must replace only supplied fields. */
export function mergeAgentBlueprintPatch<T extends object, P extends object>(
  current: T,
  patch: P,
): T & P {
  return { ...current, ...patch };
}
