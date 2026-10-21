// v1.25.0 — operator-portal session as a third auth source
//
// Pre-1.25.0 the operator portal was a separate route tree
// (/portal/<slug>/*) with its own bespoke chrome. v1.25.0 pivots:
// the operator session unlocks the SAME admin dashboard the SF
// agency operator uses (one source of truth at the route level).
//
// This module reads the sf_operator_session cookie (set by the
// magic-link verifier in lib/operator-portal/auth.ts) and produces
// the same synthetic-session shape that admin-token already uses,
// so getCurrentUser / getOrgId / requireAuth can layer it as a
// third option alongside NextAuth + admin-token.
//
// The synthetic user.id is recognizable via isOperatorPortalUserId
// so downstream code that mutates the users table can no-op for
// these sessions (mirroring the admin-token treatment).

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { isEmailInAllowlist, parseAdminAllowlist } from "@/lib/operator-portal/authorization";
import {
  OPERATOR_SESSION_COOKIE,
  isOperatorTokenRevoked,
  verifyOperatorToken,
} from "@/lib/operator-portal/session";
import { loadWorkspaceRole, type WorkspaceRole } from "./workspace-role";

const OPERATOR_PORTAL_USER_ID_PREFIX = "__sf_operator_portal__:";

export function isOperatorPortalUserId(userId: string | null | undefined): boolean {
  return Boolean(userId && userId.startsWith(OPERATOR_PORTAL_USER_ID_PREFIX));
}

export type OperatorPortalContext = {
  /** Synthetic user shape compatible with NextAuth's Session.user.
   *  The fields beyond {id, email, name, orgId, role} mirror what
   *  NextAuth's jwt callback sets on session.user (planId, trialEndsAt,
   *  subscriptionStatus, billingPeriod, soulCompleted, welcomeShown).
   *  Operator portal sessions don't carry plan/billing info, so these
   *  default to null/false-equivalents that downstream code handles
   *  gracefully (e.g. canSeldonIt → false, billing-portal redirect to
   *  /settings/billing). */
  user: {
    id: string;
    email: string;
    name: string;
    orgId: string;
    /** EPIC 2026-10-21: the workspace role re-read for this request (was a fixed "admin"). */
    role: WorkspaceRole;
    /** v1.20+ — set when this is an agency support session. */
    supportOriginUserId: string | null;
    // ── NextAuth-shape fields (operator session has no plan/billing) ─
    planId: string | null;
    subscriptionStatus: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
    billingPeriod: "monthly" | "yearly";
    trialEndsAt: string | null;
    soulCompleted: boolean;
    welcomeShown: boolean;
    image: string | null;
  };
  orgId: string;
  orgSlug: string;
};

/**
 * Resolve operator-portal context from the sf_operator_session cookie.
 * Returns null when the cookie is missing, expired, tampered, or its
 * orgId no longer corresponds to a real organization.
 *
 * Symmetrical with resolveAdminTokenContext in lib/auth/admin-token.ts.
 */
export async function resolveOperatorPortalContext(): Promise<OperatorPortalContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  const verified = verifyOperatorToken(token);
  if (!verified || verified.kind !== "session") return null;

  // Verify the org still exists. This guards against a deleted
  // workspace + stale cookie.
  const [orgRow] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      operatorSessionsValidAfter: organizations.operatorSessionsValidAfter,
    })
    .from(organizations)
    .where(eq(organizations.id, verified.orgId))
    .limit(1);
  if (!orgRow) return null;
  // EPIC 2026-10-20: the workspace's operator-session cut-off is read fresh on every request (an ownership transfer sets it).
  if (isOperatorTokenRevoked(verified, orgRow.operatorSessionsValidAfter)) return null;
  // Codex r1: a platform admin's tenant access is only ever the audited support session; any other session for it is refused.
  if (!verified.supportOriginUserId && isEmailInAllowlist(verified.email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) return null;
  // EPIC 2026-10-21: the person's standing in THIS workspace is re-read on every request — a removed member's session is
  // dead on its next request, and a role change applies at once. An agency support session is admin (unchanged; it is
  // the audited 2-hour platform path, not a membership).
  let role: WorkspaceRole;
  if (verified.supportOriginUserId) {
    role = "admin";
  } else {
    const resolved = await loadWorkspaceRole(orgRow.id, { email: verified.email });
    if (!resolved) return null;
    role = resolved.role;
  }

  return {
    user: {
      // Synthetic id — recognizable via isOperatorPortalUserId. Includes
      // the orgId so logs differentiate sessions across workspaces.
      id: `${OPERATOR_PORTAL_USER_ID_PREFIX}${verified.orgId}`,
      email: verified.email,
      name: verified.email.split("@")[0] ?? "Operator",
      orgId: verified.orgId,
      role,
      supportOriginUserId: verified.supportOriginUserId ?? null,
      // Defaults for the NextAuth-shape fields. Plan/billing aren't
      // resolvable from the operator session alone; downstream code
      // already handles null planId gracefully (free-tier UX).
      planId: null,
      subscriptionStatus: "trialing",
      billingPeriod: "monthly",
      trialEndsAt: null,
      soulCompleted: true,
      welcomeShown: true,
      image: null,
    },
    orgId: verified.orgId,
    orgSlug: orgRow.slug,
  };
}
