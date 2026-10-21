// v1.20.0 — Team settings page now also surfaces the OPERATOR INVITE UI.
//
// Pre-1.20 this page only listed users belonging to the workspace.
// In v1.20 we added the operator portal at /portal/<orgSlug> — the
// branded admin dashboard for sub-tenant operators (HVAC owner /
// dentist / accountant). To onboard a new operator you mint them
// a magic-link to that portal. This page is where you do it.
//
// Distinct from /contacts/<id> "Send invite" — that flow invites a
// CONTACT (homeowner) to the CUSTOMER portal at /customer/<orgSlug>
// with a 6-digit code. Operator invites are magic-link to /portal.
//
// EPIC 2026-10-21: the member list is COMPLETE — every person who holds a role in this workspace (membership rows, the
// owner, the creating operator, the agency owner, legacy home owners), each with the role the server actually enforces
// (lib/auth/workspace-role.ts). It previously listed only users whose HOME workspace this is, which missed members homed
// elsewhere and showed removed invitees. The owner can change a member's role, switch staff permissions and remove them.

import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { orgMembers, organizations, partnerAgencies, users } from "@/db/schema";
import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { loadWorkspaceRole, readStaffPermissionUserIds, type WorkspaceRole } from "@/lib/auth/workspace-role";
import { OperatorInviteCard } from "@/components/settings/operator-invite-card";
import { TeamMembersTable, type TeamMemberRow } from "@/components/settings/team-members-table";
import { operatorPortalOrigin } from "@/lib/operator-portal/authorization";

async function listWorkspaceMembers(orgId: string): Promise<{ rows: TeamMemberRow[]; slug: string; name: string } | null> {
  const [org] = await db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      ownerId: organizations.ownerId,
      parentUserId: organizations.parentUserId,
      parentAgencyId: organizations.parentAgencyId,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;

  const memberIds = (await db.select({ userId: orgMembers.userId }).from(orgMembers).where(eq(orgMembers.orgId, orgId))).map((r) => r.userId);
  const homeIds = (await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId))).map((r) => r.id);
  let agencyOwnerId: string | null = null;
  if (org.parentAgencyId) {
    const [agency] = await db
      .select({ ownerUserId: partnerAgencies.ownerUserId, ownerWorkspaceId: partnerAgencies.ownerWorkspaceId })
      .from(partnerAgencies)
      .where(eq(partnerAgencies.id, org.parentAgencyId))
      .limit(1);
    agencyOwnerId = agency?.ownerUserId ?? null;
    if (!agencyOwnerId && agency?.ownerWorkspaceId) {
      const [ws] = await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, agency.ownerWorkspaceId)).limit(1);
      agencyOwnerId = ws?.ownerId ?? null;
    }
  }
  const candidateIds = Array.from(
    new Set([...memberIds, ...homeIds, org.ownerId, org.parentUserId, agencyOwnerId].filter((v): v is string => Boolean(v))),
  );
  if (candidateIds.length === 0) return { rows: [], slug: org.slug, name: org.name };

  const people = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(or(...candidateIds.map((id) => eq(users.id, id))));
  const membershipRoles = new Map(
    (await db.select({ userId: orgMembers.userId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.orgId, orgId))).map((r) => [r.userId, r.role]),
  );
  const askEmployee = new Set(readStaffPermissionUserIds(org.settings, "askEmployee"));

  const rows: TeamMemberRow[] = [];
  for (const person of people) {
    // The role shown is the one the server enforces on every request.
    const resolved = await loadWorkspaceRole(orgId, { userId: person.id });
    if (!resolved) continue; // no standing here (e.g. a removed invitee whose home row remains): not a member
    const role: WorkspaceRole = resolved.role;
    rows.push({
      userId: person.id,
      name: person.name,
      email: person.email,
      role,
      // Only a plain membership row can be changed here; ownership changes only through the audited transfer.
      manageable: role !== "owner" && membershipRoles.has(person.id),
      askEmployee: askEmployee.has(person.id),
    });
  }
  const order: Record<WorkspaceRole, number> = { owner: 0, admin: 1, staff: 2 };
  rows.sort((a, b) => order[a.role] - order[b.role] || a.email.localeCompare(b.email));
  return { rows, slug: org.slug, name: org.name };
}

export default async function SettingsTeamPage() {
  const orgId = await getOrgId();
  const [listing, viewerRole, viewer] = await Promise.all([
    orgId ? listWorkspaceMembers(orgId) : Promise.resolve(null),
    getCurrentWorkspaceRole(),
    getCurrentUser(),
  ]);
  // The owner manages members in either realm (the actions re-check the same authority server-side).
  const canManage = viewerRole === "owner" && Boolean(viewer?.id);
  const orgRow = listing ? { slug: listing.slug, name: listing.name } : null;
  const rows = listing?.rows ?? [];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-light tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Invite operators to manage this workspace via the branded admin
          portal at{" "}
          <code className="font-mono text-xs">
            /portal/{orgRow?.slug ?? "(slug)"}
          </code>
          .
        </p>
      </header>

      {orgRow ? (
        <OperatorInviteCard
          orgSlug={orgRow.slug}
          orgName={orgRow.name}
          portalOrigin={operatorPortalOrigin(orgRow.slug, process.env.WORKSPACE_BASE_DOMAIN, "") || undefined}
        />
      ) : null}

      <section className="space-y-2">
        <h2 className="text-base font-semibold tracking-tight">
          Current team members
        </h2>
        {orgRow ? (
          <TeamMembersTable orgSlug={orgRow.slug} rows={rows} canManage={canManage} />
        ) : null}
      </section>
    </section>
  );
}
