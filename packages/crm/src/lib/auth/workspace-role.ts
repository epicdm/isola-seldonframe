// EPIC 2026-10-21 — workspace roles, resolved fresh on every authenticated request
// (Port def-uplink-staff-access-admin-only-invite-and-no-session-revocation-2026-10-21).
//
// One resolver for both realms that can act inside a workspace:
//   - a NextAuth user (by users.id), and
//   - a magic-link operator session (by the email the signed token carries).
// Both call loadWorkspaceRole() per request; there is no cached role in any token or cookie, so removing a
// membership or changing its role takes effect on the caller's NEXT request.
//
// Roles (the existing org_members.role text column; no schema change):
//   owner — organizations.owner_id, organizations.parent_user_id (creating operator), the owner of the partner agency
//           the workspace is attached to (owner_user_id, or the owner of its owner_workspace_id), an org_members row
//           with role 'owner', or the user whose HOME workspace this is with users.role 'owner' (legacy signup rows).
//           Same holders as lib/workspace/workspace-owner.ts canActAsWorkspaceOwner.
//   admin — an org_members row with role 'admin'.
//   staff — an org_members row with role 'staff' (or the column's legacy default 'member'). Any other value grants
//           nothing: unknown text is never admin by accident, and never access at all.
//   null  — none of the above: the caller has no standing in this workspace. A home workspace alone (users.org_id)
//           grants nothing unless users.role is 'owner'; an invited person's home row therefore stops granting access
//           the moment their membership row is removed.
//
// Pure decision logic (resolveWorkspaceRoleFromFacts) is separate from the single SQL read (loadWorkspaceRole) so the
// decision is unit-testable and the read is one round trip.

import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { orgMembers, organizations, partnerAgencies, users } from "@/db/schema";

export type WorkspaceRole = "owner" | "admin" | "staff";

/** Roles that may change settings, billing/payments, API keys, webhooks, integrations, agents, automations, domains. */
export const WORKSPACE_ADMIN_ROLES: readonly WorkspaceRole[] = ["owner", "admin"];
/** Roles an owner may grant by invitation or role change. 'owner' is never granted here (ownership transfer only). */
export const ASSIGNABLE_MEMBER_ROLES = ["staff", "admin"] as const;
export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

export function isAssignableMemberRole(value: unknown): value is AssignableMemberRole {
  return typeof value === "string" && (ASSIGNABLE_MEMBER_ROLES as readonly string[]).includes(value);
}

export function isWorkspaceAdminRole(role: WorkspaceRole | null | undefined): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

export type WorkspaceRoleFacts = {
  orgId: string;
  /** users.id of the caller, null when no users row matches. */
  userId: string | null;
  ownerId: string | null;
  parentUserId: string | null;
  /** The partner agency's human owner (owner_user_id, or the owner of its owner_workspace_id). */
  agencyOwnerUserId: string | null;
  membershipRole: string | null;
  homeOrgId: string | null;
  homeRole: string | null;
};

export function resolveWorkspaceRoleFromFacts(f: WorkspaceRoleFacts): WorkspaceRole | null {
  if (!f.userId || !f.orgId) return null;
  if (
    f.ownerId === f.userId ||
    f.parentUserId === f.userId ||
    (f.agencyOwnerUserId !== null && f.agencyOwnerUserId === f.userId) ||
    f.membershipRole === "owner" ||
    (f.homeOrgId === f.orgId && f.homeRole === "owner")
  ) {
    return "owner";
  }
  if (f.membershipRole === "admin") return "admin";
  // 'staff', and the column's legacy default 'member', are staff. Any OTHER value grants nothing (fail closed). The
  // magic-link issuance list (operator-portal/auth.ts) admits exactly the same set: owner, admin, staff, member.
  if (f.membershipRole === "staff" || f.membershipRole === "member") return "staff";
  return null;
}

export type ResolvedWorkspaceRole = { role: WorkspaceRole; userId: string };

export type WorkspaceCaller = { userId: string } | { email: string };

/**
 * The single per-request read: one query joining the workspace, the caller's users row, their membership row and the
 * partner agency. Returns null when the workspace or the caller does not exist, or the caller holds no role there.
 */
/** The default db, or a transaction (magic-link consumption reads on its locked transaction). */
type DbReader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadWorkspaceRole(orgId: string, caller: WorkspaceCaller, client: DbReader = db): Promise<ResolvedWorkspaceRole | null> {
  if (!orgId) return null;
  const byEmail = "email" in caller;
  const email = byEmail ? caller.email.trim().toLowerCase() : "";
  if (byEmail ? !email : !caller.userId) return null;

  const agencyWs = alias(organizations, "agency_ws");
  const rows = await client
    .select({
      ownerId: organizations.ownerId,
      parentUserId: organizations.parentUserId,
      agencyOwnerUserId: sql<string | null>`coalesce(${partnerAgencies.ownerUserId}, ${agencyWs.ownerId})`,
      userId: users.id,
      homeOrgId: users.orgId,
      homeRole: users.role,
      membershipRole: orgMembers.role,
    })
    .from(organizations)
    .leftJoin(users, byEmail ? sql`lower(${users.email}) = ${email}` : eq(users.id, (caller as { userId: string }).userId))
    .leftJoin(orgMembers, sql`${orgMembers.orgId} = ${organizations.id} and ${orgMembers.userId} = ${users.id}`)
    .leftJoin(partnerAgencies, eq(partnerAgencies.id, organizations.parentAgencyId))
    .leftJoin(agencyWs, eq(agencyWs.id, partnerAgencies.ownerWorkspaceId))
    .where(eq(organizations.id, orgId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.userId) return null;
  const role = resolveWorkspaceRoleFromFacts({
    orgId,
    userId: row.userId,
    ownerId: row.ownerId ?? null,
    parentUserId: row.parentUserId ?? null,
    agencyOwnerUserId: row.agencyOwnerUserId ?? null,
    membershipRole: row.membershipRole ?? null,
    homeOrgId: row.homeOrgId ?? null,
    homeRole: row.homeRole ?? null,
  });
  return role ? { role, userId: row.userId } : null;
}

// ─── owner-configurable staff permissions (organizations.settings.staffAccess; existing jsonb column) ─────────────

/** Permissions an owner can switch on per member. Every permission defaults OFF. */
export const STAFF_PERMISSIONS = ["askEmployee"] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

type StaffAccessSettings = { askEmployeeUserIds?: unknown };

/** Pure: the user ids granted a permission in organizations.settings. Malformed values grant nothing. */
export function readStaffPermissionUserIds(settings: unknown, permission: StaffPermission): string[] {
  const staffAccess = (settings as { staffAccess?: StaffAccessSettings } | null | undefined)?.staffAccess;
  const raw = permission === "askEmployee" ? staffAccess?.askEmployeeUserIds : undefined;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

export async function memberHasStaffPermission(orgId: string, userId: string, permission: StaffPermission): Promise<boolean> {
  const [row] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return readStaffPermissionUserIds(row?.settings, permission).includes(userId);
}
