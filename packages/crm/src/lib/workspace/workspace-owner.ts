// 2026-10-19 — owner-level authority for destructive and billing actions on a
// workspace (Port def-uplink-admin-member-can-delete-workspace-and-open-billing-portal-2026-10-19).
//
// listManagedOrganizations / getOrgId grant access for ANY org_members row, so
// an invited "admin" (operator-portal/auth.ts inviteWorkspaceOperatorAction)
// could otherwise hard-delete the workspace (DELETE /api/v1/workspaces/[id])
// or open its Stripe billing portal. The native role model is "an admin has
// full access except billing and member management"; this enforces the
// billing and deletion half server-side.
//
// Owner-like holder = the holders who could already do this before admins
// existed: organizations.ownerId, organizations.parentUserId (the creating
// operator), an org_members row with role "owner", the owner of the partner
// agency the workspace is attached to, or the user whose PRIMARY workspace this
// is with users.role "owner" (legacy signup rows; getCurrentWorkspaceRole reads
// users.role for the primary workspace). An "admin" or "member" row is never
// enough on its own.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgMembers, organizations, partnerAgencies, users } from "@/db/schema";

export type WorkspaceOwnerCheck = {
  userId: string | null | undefined;
  ownerId: string | null;
  parentUserId: string | null;
  membershipRole: string | null | undefined;
  agencyAttachedToUser: boolean;
  primaryWorkspaceOwnerRole: boolean;
};

export function canActAsWorkspaceOwner(i: WorkspaceOwnerCheck): boolean {
  if (!i.userId) return false;
  return (
    i.ownerId === i.userId ||
    i.parentUserId === i.userId ||
    i.membershipRole === "owner" ||
    i.agencyAttachedToUser ||
    i.primaryWorkspaceOwnerRole
  );
}

/** Loads the inputs for canActAsWorkspaceOwner for one (workspace, user). Null when the workspace does not exist. */
export async function loadWorkspaceOwnerCheck(orgId: string, userId: string): Promise<WorkspaceOwnerCheck | null> {
  const [org] = await db
    .select({
      ownerId: organizations.ownerId,
      parentUserId: organizations.parentUserId,
      parentAgencyId: organizations.parentAgencyId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;

  const [member] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);

  const [user] = await db
    .select({ orgId: users.orgId, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  let agencyAttachedToUser = false;
  if (org.parentAgencyId) {
    const [agency] = await db
      .select({ id: partnerAgencies.id })
      .from(partnerAgencies)
      .where(and(eq(partnerAgencies.id, org.parentAgencyId), eq(partnerAgencies.ownerUserId, userId)))
      .limit(1);
    agencyAttachedToUser = Boolean(agency?.id);
  }

  return {
    userId,
    ownerId: org.ownerId,
    parentUserId: org.parentUserId,
    membershipRole: member?.role ?? null,
    agencyAttachedToUser,
    primaryWorkspaceOwnerRole: user?.orgId === orgId && user?.role === "owner",
  };
}

export async function isWorkspaceOwnerLike(orgId: string, userId: string): Promise<boolean> {
  const check = await loadWorkspaceOwnerCheck(orgId, userId);
  return Boolean(check && canActAsWorkspaceOwner(check));
}
