// EPIC 2026-10-20 — whether a user holds an AUTHORISED agency (reseller) relationship. Display gate only: agency wording and
// agency-only entry points render when this is true; an ordinary multi-workspace tenant sees neutral "Workspaces" wording.
// It grants nothing: every agency capability keeps its own server-side check (support sessions, sub-account attach, white-label).
//
// Authorised = a partner_agencies row owned by the user with status 'active' AND its billing workspace (owner_workspace_id, or
// the user's primary org when that is unset) resolving to an agency-family tier. A pending/suspended agency, or an agency
// whose workspace is not on an agency plan, is not authorised. Port plan-epic-execution-control-current-2026-10-20 (v1.12).

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { partnerAgencies, users } from "@/db/schema";
import { normalizeTierId, type BillingTier } from "@/lib/billing/features";
import { resolveTierForWorkspace } from "@/lib/billing/tier-resolver";

const AGENCY_TIERS: ReadonlySet<string> = new Set(["agency", "agency_starter", "agency_growth", "agency_scale"]);

export function isAgencyTier(tier: BillingTier): boolean {
  return AGENCY_TIERS.has(tier);
}

export async function hasAuthorizedAgency(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const rows = await db
      .select({ ownerWorkspaceId: partnerAgencies.ownerWorkspaceId })
      .from(partnerAgencies)
      .where(and(eq(partnerAgencies.ownerUserId, userId), eq(partnerAgencies.status, "active")));
    if (rows.length === 0) return false;
    let primaryOrgId: string | null | undefined;
    for (const row of rows) {
      let workspaceId = row.ownerWorkspaceId;
      if (!workspaceId) {
        if (primaryOrgId === undefined) {
          const [user] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).limit(1);
          primaryOrgId = user?.orgId ?? null;
        }
        workspaceId = primaryOrgId;
      }
      if (workspaceId && isAgencyTier(normalizeTierId(await resolveTierForWorkspace(workspaceId)))) return true;
    }
    return false;
  } catch (error) {
    // Fail neutral: on a read failure the operator sees tenant wording; no capability depends on this flag.
    console.error(JSON.stringify({ event: "authorized_agency_read_failed", error: String(error).slice(0, 200) }));
    return false;
  }
}
