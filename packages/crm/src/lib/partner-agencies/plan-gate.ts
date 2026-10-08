// Pure plan gate for agency registration (no I/O, unit-testable without a database).
//
// The Stripe webhook writes the subscription tier into organizations.plan (lib/billing/subscription.ts), so a paying
// Agency customer carries agency_starter / agency_growth / agency_scale. The original gate only knew the legacy value
// "scale", which left every current Agency subscriber "pending".
//
// This is deliberately an EXPLICIT list, not normalizeTierId: that function folds legacy values such as "pro" into the
// agency tier, and several signup paths write plan "pro" onto ordinary user workspaces (lib/billing/orgs.ts), so using it
// here would let almost any account register an active agency.

const AGENCY_PLAN_VALUES: ReadonlySet<string> = new Set([
  "agency_starter",
  "agency_growth",
  "agency_scale",
  "agency", // grandfathered
  "scale", // the only value the original gate accepted (kept, so existing rows behave identically)
]);

/** Does this stored plan (or subscription tier) unlock agency registration? */
export function planUnlocksAgency(plan: string | null | undefined): boolean {
  if (typeof plan !== "string") return false;
  return AGENCY_PLAN_VALUES.has(plan.trim().toLowerCase());
}
