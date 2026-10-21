// EPIC 2026-10-21 — server-side role guards for sensitive actions, routes and pages
// (Port def-uplink-staff-access-admin-only-invite-and-no-session-revocation-2026-10-21; plan v1.47: page restrictions
// alone are insufficient).
//
// requireWorkspaceAdmin() is the FIRST statement of every sensitive server action (the complete list and the test that
// enforces it: lib/auth/staff-access-policy.ts, tests/integration/staff-access.spec.ts). It reads the caller's role
// fresh (getCurrentWorkspaceRole -> lib/auth/workspace-role.ts), so a role change or removal applies on the next call.
//
// Not a "use server" module: nothing here is callable from the client.

import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "./helpers";
import { isAdminTokenUserId } from "./admin-token";
import { isOperatorPortalUserId } from "./operator-portal-context";
import { isWorkspaceAdminRole, loadWorkspaceRole, memberHasStaffPermission, type WorkspaceRole } from "./workspace-role";

export const WORKSPACE_ROLE_FORBIDDEN = "workspace_role_forbidden";

export class WorkspaceRoleForbiddenError extends Error {
  readonly code = WORKSPACE_ROLE_FORBIDDEN;
  readonly role: WorkspaceRole | null;
  constructor(role: WorkspaceRole | null) {
    super(`${WORKSPACE_ROLE_FORBIDDEN}: this action needs a workspace owner or admin`);
    this.name = "WorkspaceRoleForbiddenError";
    this.role = role;
  }
}

export function isWorkspaceRoleForbiddenError(error: unknown): error is WorkspaceRoleForbiddenError {
  return (error as { code?: unknown } | null)?.code === WORKSPACE_ROLE_FORBIDDEN;
}

/**
 * Throws WorkspaceRoleForbiddenError unless the caller is owner or admin of the active workspace.
 * When NOBODY is signed in there is nothing to authorize: it returns, and the action's own session check answers with its
 * own typed "unauthorized" / "auth_required" exactly as it did before this guard existed (logged-out visitors of the public
 * marketplace pages depend on that contract). Anyone who IS signed in without owner/admin standing here - staff, a removed
 * member, a stranger - is refused.
 */
export async function requireWorkspaceAdmin(): Promise<void> {
  const role = await getCurrentWorkspaceRole();
  if (isWorkspaceAdminRole(role)) return;
  if (!(await getCurrentUser())) return;
  // contract:throw-ok: role refusal for a signed-in non-admin; the UI never offers these actions to staff, and a masked
  // failure is the intended fail-closed outcome. The page layouts redirect staff before any of these controls render.
  throw new WorkspaceRoleForbiddenError(role);
}

/**
 * getOrgId() for admin-only actions whose org lookup is a dependency-injection seam (`deps.getOrgId ?? ...`): the
 * DEFAULT is this guarded resolver, so production always passes the role check; only server-side tests that inject
 * their own getOrgId skip it (they already replace authentication entirely).
 */
export async function getOrgIdAsWorkspaceAdmin(): Promise<string | null> {
  await requireWorkspaceAdmin();
  return getOrgId();
}

/**
 * The caller's role in a SPECIFIC workspace (not necessarily the active one) — for handlers whose mutation target is a
 * client-supplied workspace or the NextAuth user's home workspace. A magic-link or admin-token session only ever has a
 * role in its own workspace; a NextAuth user's role is read fresh for `orgId`.
 */
export async function getCallerRoleIn(orgId: string | null | undefined): Promise<WorkspaceRole | null> {
  if (!orgId) return null;
  const user = await getCurrentUser();
  if (!user?.id) return null;
  if (isAdminTokenUserId(user.id) || isOperatorPortalUserId(user.id)) {
    const sessionOrgId = await getOrgId();
    return sessionOrgId === orgId ? await getCurrentWorkspaceRole() : null;
  }
  return (await loadWorkspaceRole(orgId, { userId: user.id }))?.role ?? null;
}

/**
 * The workspace a READ runs against when a caller may pass one explicitly (operator-portal mirrors pass their session's
 * workspace): honoured only if the caller holds a role there right now, else nothing; no override = the active workspace.
 */
export async function orgIdForCallerRead(orgIdOverride?: unknown): Promise<string | null> {
  if (orgIdOverride === undefined || orgIdOverride === null || orgIdOverride === "") return getOrgId();
  if (typeof orgIdOverride !== "string") return null;
  return (await getCallerRoleIn(orgIdOverride)) ? orgIdOverride : null;
}

/** Throws WorkspaceRoleForbiddenError unless the caller is owner or admin of `orgId` (the exact mutation target). */
export async function requireWorkspaceAdminFor(orgId: string | null | undefined): Promise<void> {
  const role = await getCallerRoleIn(orgId);
  if (isWorkspaceAdminRole(role)) return;
  if (!(await getCurrentUser())) return; // nobody signed in: the action's own session check answers (see requireWorkspaceAdmin)
  // contract:throw-ok: role refusal for a signed-in non-admin of the target workspace (see requireWorkspaceAdmin).
  throw new WorkspaceRoleForbiddenError(role);
}

/** Route twin of requireWorkspaceAdminFor: null when allowed, else the 403 to return. */
export async function workspaceAdminRouteRefusalFor(orgId: string | null | undefined): Promise<NextResponse | null> {
  const role = await getCallerRoleIn(orgId);
  if (isWorkspaceAdminRole(role)) return null;
  return NextResponse.json({ error: "forbidden", code: WORKSPACE_ROLE_FORBIDDEN }, { status: 403, headers: { "cache-control": "no-store" } });
}

/** For session-authenticated route handlers: null when the caller is owner/admin, else the refusal to return. */
export async function workspaceAdminRouteRefusal(): Promise<NextResponse | null> {
  const role = await getCurrentWorkspaceRole();
  if (isWorkspaceAdminRole(role)) return null;
  return NextResponse.json(
    { error: "forbidden", code: WORKSPACE_ROLE_FORBIDDEN },
    { status: role ? 403 : 401, headers: { "cache-control": "no-store" } },
  );
}

/** For admin-only pages: a staff member (or anyone without owner/admin) is sent to the dashboard. */
export async function redirectUnlessWorkspaceAdmin(to = "/dashboard"): Promise<void> {
  const role = await getCurrentWorkspaceRole();
  if (!isWorkspaceAdminRole(role)) redirect(to);
}

// ─── ask_employee caller identity (Company lane bridge, X-Staff-Id) ───────────────────────────────────────────────

export type AskEmployeeCaller =
  | { ok: true; orgId: string; staffId: string; role: WorkspaceRole }
  | { ok: false; reason: "no_staff_session" | "not_a_member" | "permission_off" | "staff_id_mismatch" | "workspace_mismatch" };

/**
 * The staff id the ask_employee bridge keys on. Derived ONLY from the signed-in session's member (users.id), re-read on
 * every call: never from request input, tool arguments or model output. `requestedStaffId` exists only so a caller that
 * was handed an id can be refused when it is not the session's own; it never selects the id.
 * Refused for: no session, an admin-token or agency-support session (no person), a caller with no role in the
 * workspace (e.g. a removed member), a workspace other than the session's, or the owner-configurable permission OFF.
 */
export async function resolveAskEmployeeCaller(input: { orgId?: string; requestedStaffId?: unknown } = {}): Promise<AskEmployeeCaller> {
  const user = await getCurrentUser();
  const orgId = await getOrgId();
  if (!user?.id || !orgId || isAdminTokenUserId(user.id)) return { ok: false, reason: "no_staff_session" };
  if (input.orgId !== undefined && input.orgId !== orgId) return { ok: false, reason: "workspace_mismatch" };

  let resolved: { role: WorkspaceRole; userId: string } | null;
  if (isOperatorPortalUserId(user.id)) {
    if ((user as { supportOriginUserId?: string | null }).supportOriginUserId) return { ok: false, reason: "no_staff_session" };
    resolved = await loadWorkspaceRole(orgId, { email: String(user.email ?? "") });
  } else {
    resolved = await loadWorkspaceRole(orgId, { userId: user.id });
  }
  if (!resolved) return { ok: false, reason: "not_a_member" };
  if (input.requestedStaffId !== undefined && input.requestedStaffId !== resolved.userId) return { ok: false, reason: "staff_id_mismatch" };
  if (!(await memberHasStaffPermission(orgId, resolved.userId, "askEmployee"))) return { ok: false, reason: "permission_off" };
  return { ok: true, orgId, staffId: resolved.userId, role: resolved.role };
}
