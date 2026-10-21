import { auth } from "@/auth";
import type { Session } from "next-auth";
import { and, eq, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgMembers, organizations, partnerAgencies, users } from "@/db/schema";
import {
  isAdminTokenUserId,
  resolveAdminTokenContext,
} from "./admin-token";
import {
  isOperatorPortalUserId,
  resolveOperatorPortalContext,
} from "./operator-portal-context";
import { loadWorkspaceRole, type WorkspaceRole } from "./workspace-role";

/**
 * Server components and route handlers can authenticate via THREE sources:
 *   1. NextAuth session (interactive login)
 *   2. Admin-token cookie (set by /admin/[workspaceId]?token=wst_…)
 *   3. v1.25.0 — Operator-portal session (sf_operator_session cookie).
 *      Set by the magic-link verifier in lib/operator-portal/auth.ts
 *      OR by createAgencySupportSession. Yields a synthetic Session-
 *      shaped object whose user.id carries the
 *      `__sf_operator_portal__:` prefix; downstream code that mutates
 *      the users table can no-op for these sessions via
 *      isOperatorPortalUserId, mirroring the admin-token treatment.
 *
 * Resolution order: NextAuth → operator portal → admin-token.
 * Operator portal precedes admin-token because the magic-link flow
 * is the dominant white-label entry path.
 */
export async function getCurrentUser() {
  // v1.25.2 — operator-portal session takes PRECEDENCE over NextAuth
  // when the cookie is explicitly set. Reason: when a user clicks
  // an operator magic link, their intent is clearly to use the
  // operator portal — even if they happen to have a stale NextAuth
  // session in the same browser (common: tried /signup earlier and
  // got the verification error but still got a partial NextAuth
  // cookie set; or this is the SF agency operator opening their
  // client's portal in the same browser as their own dashboard).
  // Operator cookie wins if present + valid; falls through to
  // NextAuth otherwise.
  const opCtx = await resolveOperatorPortalContext();
  if (opCtx) return opCtx.user;

  const session = await auth();
  if (session?.user) return session.user;

  const adminCtx = await resolveAdminTokenContext();
  if (adminCtx) return adminCtx.user;

  return null;
}

export async function getOrgId() {
  // v1.25.2 — operator-portal session takes precedence (same reason
  // as getCurrentUser above). Workspace-scoped, single round-trip.
  const opCtx = await resolveOperatorPortalContext();
  if (opCtx) return opCtx.orgId;

  // C6: admin-token sessions are scoped to a single workspace by design;
  // skip the user/org-membership round-trip and return the token's orgId.
  const adminCtx = await resolveAdminTokenContext();
  if (adminCtx) return adminCtx.orgId;

  const user = await getCurrentUser();

  if (!user?.id) {
    return null;
  }

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get("sf_active_org_id")?.value;

  // EPIC 2026-10-21: the HOME workspace (users.org_id) is re-checked on every request. An invited person's home row
  // grants nothing once their membership is removed (lib/auth/workspace-role.ts), so they get no workspace at all.
  const homeOrgIfStillHeld = async () =>
    user.orgId && (await loadWorkspaceRole(user.orgId, { userId: user.id })) ? user.orgId : null;

  if (!activeOrgId) {
    return homeOrgIfStillHeld();
  }

  if (activeOrgId === user.orgId) {
    return homeOrgIfStillHeld();
  }

  const [memberOrg] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, activeOrgId), eq(orgMembers.userId, user.id)))
    .limit(1);

  if (memberOrg?.orgId) {
    return memberOrg.orgId;
  }

  const [managedOrg] = await db
    .select({ id: organizations.id, parentAgencyId: organizations.parentAgencyId })
    .from(organizations)
    .where(and(eq(organizations.id, activeOrgId), or(eq(organizations.ownerId, user.id), eq(organizations.parentUserId, user.id))))
    .limit(1);

  if (managedOrg?.id) {
    return managedOrg.id;
  }

  // 2026-06-16 — agency-attached workspaces. When a workspace was
  // created anonymously and later attached to a partner agency via
  // attachWorkspaceToAgency, ownerId and parentUserId remain null.
  // The agency owner should still be able to switch into these
  // workspaces. Check whether the active org's parentAgencyId points
  // to a partner agency owned by this user.
  const [agencyWs] = await db
    .select({ id: organizations.id, parentAgencyId: organizations.parentAgencyId })
    .from(organizations)
    .where(eq(organizations.id, activeOrgId))
    .limit(1);
  if (agencyWs?.parentAgencyId) {
    const [agency] = await db
      .select({ id: partnerAgencies.id })
      .from(partnerAgencies)
      .where(
        and(
          eq(partnerAgencies.id, agencyWs.parentAgencyId),
          eq(partnerAgencies.ownerUserId, user.id),
        ),
      )
      .limit(1);
    if (agency?.id) {
      return activeOrgId;
    }
  }

  return homeOrgIfStillHeld();
}

export async function requireAuth() {
  // v1.25.2 — operator-portal session takes precedence over NextAuth
  // when the cookie is set. See getCurrentUser comment for rationale
  // (intent-based: clicking an operator magic link means the user
  // wants the operator portal even if they have stale NextAuth in
  // the same browser).
  const opCtx = await resolveOperatorPortalContext();
  if (opCtx) {
    const synthetic: Session = {
      user: opCtx.user,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    return synthetic;
  }

  const session = await auth();
  if (session?.user) return session;

  // C6: admin-token cookie produces a synthetic session so the dashboard
  // layout / page renders without redirecting to /login.
  const adminCtx = await resolveAdminTokenContext();
  if (adminCtx) {
    const synthetic: Session = {
      user: adminCtx.user,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    return synthetic;
  }

  redirect("/login");
}

/**
 * EPIC 2026-10-21: the caller's role in the active workspace, read fresh on every call (lib/auth/workspace-role.ts).
 * "owner" | "admin" | "staff", or null when there is no session or no standing in the workspace.
 *   - admin-token sessions are workspace admin (unchanged; no users row exists for the synthetic id);
 *   - operator-portal (magic-link) sessions carry the role resolveOperatorPortalContext just re-read for that email;
 *     an agency SUPPORT session is admin (unchanged);
 *   - NextAuth users resolve through loadWorkspaceRole (membership row, ownership, agency ownership, legacy home owner).
 */
export async function getCurrentWorkspaceRole(): Promise<WorkspaceRole | null> {
  const user = await getCurrentUser();
  const orgId = await getOrgId();

  if (!user?.id || !orgId) {
    return null;
  }

  // C6: admin-token sessions are always workspace admin. Skip the
  // users / org_members lookup since the synthetic user.id doesn't
  // exist in either table.
  if (isAdminTokenUserId(user.id)) {
    return "admin";
  }

  // Operator-portal sessions: the role was resolved per request in resolveOperatorPortalContext (a removed member has
  // no context at all, so never reaches here).
  if (isOperatorPortalUserId(user.id)) {
    const role = (user as { role?: string }).role;
    return role === "owner" || role === "admin" || role === "staff" ? role : null;
  }

  return (await loadWorkspaceRole(orgId, { userId: user.id }))?.role ?? null;
}

/**
 * True when this user may act in `orgId`: the same admission rules getOrgId()
 * applies when switching the active workspace (an org_members row,
 * organizations.ownerId / parentUserId, ownership of the partner agency the
 * workspace is attached to, or a home workspace the user still holds a role in).
 * For server actions that receive an orgId from the client: a workspace the
 * caller cannot switch into is treated exactly like one that does not exist.
 */
export async function userCanAccessOrg(userId: string, orgId: string): Promise<boolean> {
  if (!userId || !orgId) return false;

  // EPIC 2026-10-21: a home workspace counts only while the user still holds a role there (removal ends it).
  const [home] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).limit(1);
  if (home?.orgId === orgId) return Boolean(await loadWorkspaceRole(orgId, { userId }));

  const [member] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (member?.orgId) return true;

  const [org] = await db
    .select({ ownerId: organizations.ownerId, parentUserId: organizations.parentUserId, parentAgencyId: organizations.parentAgencyId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return false;
  if (org.ownerId === userId || org.parentUserId === userId) return true;

  if (org.parentAgencyId) {
    const [agency] = await db
      .select({ id: partnerAgencies.id })
      .from(partnerAgencies)
      .where(and(eq(partnerAgencies.id, org.parentAgencyId), eq(partnerAgencies.ownerUserId, userId)))
      .limit(1);
    if (agency?.id) return true;
  }

  return false;
}
