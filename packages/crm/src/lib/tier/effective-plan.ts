// EPIC 2026-10-05 -- effective plan for the legacy per-workspace gates in ./limits.ts.
//
// lib/billing/tier-resolver.ts (2026-05-17) lets an agency-managed client workspace inherit its operator's tier instead of its
// own always-free row, and checkPortalPlanGate already uses it. The older gates in ./limits.ts (portal, landing pages, AI calls,
// team members) kept reading the workspace's OWN plan, so a customer could pass the sign-in gate and then hit
// `upgrade_required portalEnabled tier=starter` on the portal home. This helper lets those gates agree with the resolver.
//
// Pure on purpose: no DB, so it is unit-testable. A workspace that already has its own paid plan keeps it.

/** True when the plan string would resolve to the Starter cloud tier in ./limits.ts (free, empty, unknown). */
export function isStarterLikePlan(plan: string | null | undefined): boolean {
  const normalized = (plan || "").toLowerCase();
  return !(
    normalized.includes("scale") ||
    normalized.includes("enterprise") ||
    normalized.includes("growth") ||
    normalized.includes("pro")
  );
}

/**
 * The plan the legacy gates should use: the workspace's own plan when it is paid, otherwise the tier inherited from the
 * agency chain (when that is a real tier, not "inactive").
 */
export function pickEffectivePlan(
  ownPlan: string | null | undefined,
  inheritedTier: string | null | undefined,
): string {
  const own = ownPlan ?? "";
  if (!isStarterLikePlan(own)) return own;
  if (!inheritedTier || inheritedTier === "inactive") return own;
  return inheritedTier;
}