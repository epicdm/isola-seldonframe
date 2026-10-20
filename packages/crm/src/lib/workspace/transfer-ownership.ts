// EPIC 2026-10-20 — audited, platform-admin-only transfer of an OWNED workspace to a new owner, its state-checked rollback, and the
// internal (payment-off) entitlement that must precede it (Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20).
//
// Every existing ownerId writer only creates a workspace or claims an unowned one (link-workspace-to-operator.ts, the link-owner
// route, claimAnonymousWorkspaceForEmail); this is the missing owned -> owned path, written next to linkWorkspaceToOperator and with
// the same ownerId + org_members pattern. Ownership in this codebase is not one column: owner-like authority
// (workspace-owner.ts canActAsWorkspaceOwner) also comes from org_members role 'owner' and from the user's HOME workspace
// (users.orgId + role 'owner'), and six runtime paths find "the workspace's owner" through users.orgId. So one transaction moves
// all of it: ownerId, the new owner's membership and home, the old owner's home (cleared, so platform authority stays role-based
// via SF_SUPERADMIN_EMAILS, never derived from owning a workspace), the old owner's membership, and the operator-session cut-off.
//
// Safeguards: platform-admin actor; expected current owner (a concurrent change refuses); the workspace must already hold its own
// entitlement (its tier may not come from the owner) and that tier is asserted unchanged; owner-like status is asserted inside the
// transaction; the audit row is written in the same transaction; rollback revalidates the recorded after-state and refuses on any
// drift, and never revives revoked operator sessions (the cut-off only moves forward).
//
// Requires a driver with interactive transactions (DB_DRIVER=pg, which production uses). On the neon-http driver db.transaction
// throws before any write, so the action fails closed with nothing changed.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { orgMembers, organizations, partnerAgencies, users, workspaceAdminActions } from "@/db/schema";
import type { OrganizationSubscription } from "@/db/schema";
import { normalizeTierId } from "@/lib/billing/features";
import { updateOrgSubscription } from "@/lib/billing/subscription";
import { emitSeldonEvent } from "@/lib/events/bus";
import { isEmailInAllowlist, normalizeEmail, parseAdminAllowlist } from "@/lib/operator-portal/authorization";
import { canActAsWorkspaceOwner } from "./workspace-owner";

export type PlatformAdminActor = { userId: string; email: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Client = typeof db | Tx;

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function isPlatformAdmin(email: string | null | undefined): boolean {
  return isEmailInAllowlist(email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS));
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** The tier the workspace holds BY ITSELF (the first thing resolveTierForWorkspace returns), independent of who owns it. */
export function ownTierOf(org: { plan: string | null; subscription: unknown }): string {
  const subscription = org.subscription as { tier?: string } | null | undefined;
  return normalizeTierId(subscription?.tier ?? org.plan ?? "inactive");
}

type UserState = { id: string; email: string; orgId: string; role: string };
type MemberState = { userId: string; role: string };
export type OwnershipState = {
  ownerId: string | null;
  parentUserId: string | null;
  parentAgencyId: string | null;
  ownTier: string;
  operatorSessionsValidAfter: string | null;
  users: UserState[];
  members: MemberState[];
};

async function lockAndRead(client: Client, orgId: string, userIds: string[]): Promise<OwnershipState | null> {
  // Row locks: the workspace and both users stay fixed until commit (concurrent transfers or edits wait, then see the new state).
  await client.execute(sql`select id from organizations where id = ${orgId}::uuid for update`);
  if (userIds.length > 0) {
    await client.execute(sql`select id from users where id in (${sql.join(userIds.map((u) => sql`${u}::uuid`), sql`, `)}) for update`);
  }
  return readState(client, orgId, userIds);
}

async function readState(client: Client, orgId: string, userIds: string[]): Promise<OwnershipState | null> {
  const [org] = await client
    .select({
      ownerId: organizations.ownerId,
      parentUserId: organizations.parentUserId,
      parentAgencyId: organizations.parentAgencyId,
      plan: organizations.plan,
      subscription: organizations.subscription,
      operatorSessionsValidAfter: organizations.operatorSessionsValidAfter,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;
  const userRows = userIds.length
    ? await client.select({ id: users.id, email: users.email, orgId: users.orgId, role: users.role }).from(users).where(inArray(users.id, userIds))
    : [];
  const memberRows = await client.select({ userId: orgMembers.userId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  return {
    ownerId: org.ownerId,
    parentUserId: org.parentUserId,
    parentAgencyId: org.parentAgencyId,
    ownTier: ownTierOf(org),
    operatorSessionsValidAfter: org.operatorSessionsValidAfter ? new Date(org.operatorSessionsValidAfter).toISOString() : null,
    users: [...userRows].sort((a, b) => a.id.localeCompare(b.id)),
    members: [...memberRows].sort((a, b) => a.userId.localeCompare(b.userId) || a.role.localeCompare(b.role)),
  };
}

async function isOwnerLikeIn(client: Client, orgId: string, state: OwnershipState, userId: string): Promise<boolean> {
  let agencyAttachedToUser = false;
  if (state.parentAgencyId) {
    const [agency] = await client
      .select({ id: partnerAgencies.id })
      .from(partnerAgencies)
      .where(and(eq(partnerAgencies.id, state.parentAgencyId), eq(partnerAgencies.ownerUserId, userId)))
      .limit(1);
    agencyAttachedToUser = Boolean(agency?.id);
  }
  const user = state.users.find((u) => u.id === userId);
  return canActAsWorkspaceOwner({
    userId,
    ownerId: state.ownerId,
    parentUserId: state.parentUserId,
    membershipRole: state.members.find((m) => m.userId === userId)?.role ?? null,
    agencyAttachedToUser,
    primaryWorkspaceOwnerRole: user?.orgId === orgId && user?.role === "owner",
  });
}

/** Key-order-independent serialisation (a jsonb round trip reorders object keys). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Everything but the cut-off, which only ever moves forward and so is not part of "has the state drifted". */
function comparable(state: OwnershipState) {
  const { operatorSessionsValidAfter: _ignored, ...rest } = state;
  void _ignored;
  return canonical(rest);
}

async function writeAudit(
  client: Client,
  row: {
    orgId: string;
    action: "ownership_transfer" | "ownership_transfer_rollback" | "internal_entitlement";
    outcome: "applied" | "refused" | "failed";
    reason?: string | null;
    actor: PlatformAdminActor;
    before?: unknown;
    after?: unknown;
    revertsActionId?: string | null;
  },
): Promise<string | null> {
  const [inserted] = await client
    .insert(workspaceAdminActions)
    .values({
      orgId: row.orgId,
      action: row.action,
      outcome: row.outcome,
      reason: row.reason ?? null,
      actorUserId: row.actor.userId,
      actorEmail: normalizeEmail(row.actor.email),
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
      revertsActionId: row.revertsActionId ?? null,
    })
    .returning({ id: workspaceAdminActions.id });
  return inserted?.id ?? null;
}

/** A refusal or failure is recorded outside the (rolled-back) transaction; the record is best-effort and never changes the answer. */
async function recordRefusal(
  orgId: string,
  action: "ownership_transfer" | "ownership_transfer_rollback" | "internal_entitlement",
  actor: PlatformAdminActor,
  error: unknown,
  extra?: { revertsActionId?: string | null },
): Promise<{ ok: false; reason: string; actionId?: string }> {
  const refused = error instanceof Refusal;
  const reason = refused ? error.reason : "failed";
  let actionId: string | null = null;
  try {
    actionId = await writeAudit(db, {
      orgId,
      action,
      outcome: refused ? "refused" : "failed",
      reason: refused ? error.reason : `failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
      actor,
      revertsActionId: extra?.revertsActionId ?? null,
    });
  } catch {
    // The refusal stands even if it cannot be recorded.
  }
  return { ok: false, reason, ...(actionId ? { actionId } : {}) };
}

function assertActor(actor: PlatformAdminActor) {
  if (!actor?.userId || !isPlatformAdmin(actor.email)) throw new Refusal("not_platform_admin");
}

// ─── internal entitlement (must precede a transfer) ───────────────────────────

export type SetInternalEntitlementInput = { orgId: string; tier: string; actor: PlatformAdminActor };
export type SetInternalEntitlementResult =
  | { ok: true; actionId: string; tier: string; plan: string }
  | { ok: false; reason: string; actionId?: string };

/**
 * Give the workspace its OWN plan with payment collection off: the existing updateOrgSubscription with { tier, status: "active" }
 * and no Stripe ids (it also sets organizations.plan = tier). resolveTierForWorkspace returns a workspace's own tier before any
 * owner-derived tier, so this entitlement no longer depends on who owns the workspace. Refuses a workspace whose subscription is
 * managed by Stripe, and any tier that resolves to nothing.
 */
export async function setInternalWorkspaceEntitlement(input: SetInternalEntitlementInput): Promise<SetInternalEntitlementResult> {
  try {
    assertActor(input.actor);
    const resolved = normalizeTierId(input.tier);
    if (resolved === "inactive") throw new Refusal("unknown_tier");
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select id from organizations where id = ${input.orgId}::uuid for update`);
      const [org] = await tx
        .select({ plan: organizations.plan, subscription: organizations.subscription })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      if (!org) throw new Refusal("workspace_not_found");
      const subscription = (org.subscription ?? {}) as OrganizationSubscription;
      if (subscription.stripeSubscriptionId || subscription.stripeCustomerId || subscription.stripePriceId) {
        throw new Refusal("stripe_managed_subscription");
      }
      const before = { plan: org.plan, tier: subscription.tier ?? null, status: subscription.status ?? null, ownTier: ownTierOf(org) };
      await updateOrgSubscription(input.orgId, { tier: input.tier, status: "active" }, tx);
      const [after] = await tx
        .select({ plan: organizations.plan, subscription: organizations.subscription })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      if (!after || ownTierOf(after) !== resolved) throw new Refusal("entitlement_not_applied");
      const afterSub = (after.subscription ?? {}) as OrganizationSubscription;
      const actionId = await writeAudit(tx, {
        orgId: input.orgId,
        action: "internal_entitlement",
        outcome: "applied",
        actor: input.actor,
        before,
        after: { plan: after.plan, tier: afterSub.tier ?? null, status: afterSub.status ?? null, ownTier: ownTierOf(after), paymentCollection: "off" },
      });
      if (!actionId) throw new Refusal("audit_write_failed");
      return { ok: true as const, actionId, tier: input.tier, plan: after.plan };
    });
  } catch (error) {
    return recordRefusal(input.orgId, "internal_entitlement", input.actor, error);
  }
}

// ─── ownership transfer ───────────────────────────────────────────────────────

export type TransferWorkspaceOwnershipInput = {
  orgId: string;
  expectedCurrentOwnerId: string;
  newOwnerUserId: string;
  /** The tier the workspace must already hold by itself, e.g. "growth" (compared after normalisation). */
  expectedTier: string;
  /**
   * Where the old owner's HOME goes when its home is this workspace. users.org_id is NOT NULL (and cascades on workspace delete), so a home
   * cannot be cleared; it moves to a workspace the old owner ALREADY owns (owner_id or an owner membership), so no access is granted.
   * Required in that case; ignored otherwise.
   */
  oldOwnerHomeOrgId?: string;
  actor: PlatformAdminActor;
  /** Test seam for the cut-off clock; production uses the application clock (the same clock that stamps token iat). */
  now?: () => Date;
};
export type TransferWorkspaceOwnershipResult =
  | { ok: true; actionId: string; alreadyApplied: boolean; operatorSessionsValidAfter: string | null }
  | { ok: false; reason: string; actionId?: string };

export async function transferWorkspaceOwnership(input: TransferWorkspaceOwnershipInput): Promise<TransferWorkspaceOwnershipResult> {
  const now = input.now ?? (() => new Date());
  try {
    assertActor(input.actor);
    if (!input.orgId || !input.expectedCurrentOwnerId || !input.newOwnerUserId) throw new Refusal("missing_required_field");
    if (input.newOwnerUserId === input.expectedCurrentOwnerId) throw new Refusal("same_owner");
    const expectedTier = normalizeTierId(input.expectedTier);
    if (expectedTier === "inactive") throw new Refusal("unknown_tier");

    const outcome = await db.transaction(async (tx) => {
      const ids = [input.expectedCurrentOwnerId, input.newOwnerUserId];
      const before = await lockAndRead(tx, input.orgId, ids);
      if (!before) throw new Refusal("workspace_not_found");
      const oldOwner = before.users.find((u) => u.id === input.expectedCurrentOwnerId);
      const newOwner = before.users.find((u) => u.id === input.newOwnerUserId);

      // Idempotent re-run: already transferred by an applied, un-reverted transfer -> answer it, write nothing.
      if (before.ownerId === input.newOwnerUserId && newOwner?.orgId === input.orgId) {
        const prior = await latestAppliedTransfer(tx, input.orgId);
        if (prior && (prior.after as { ownerId?: string } | null)?.ownerId === input.newOwnerUserId) {
          return { alreadyApplied: true as const, actionId: prior.id, validAfter: before.operatorSessionsValidAfter };
        }
      }

      if (before.ownerId !== input.expectedCurrentOwnerId) throw new Refusal("owner_changed");
      if (!oldOwner) throw new Refusal("current_owner_not_found");
      if (!newOwner) throw new Refusal("new_owner_not_found");
      if (isPlatformAdmin(newOwner.email)) throw new Refusal("new_owner_is_platform_admin");
      if (before.ownTier === "inactive") throw new Refusal("entitlement_depends_on_owner");
      if (before.ownTier !== expectedTier) throw new Refusal("tier_mismatch");

      const cutoff = now();
      await tx
        .update(organizations)
        .set({ ownerId: newOwner.id, operatorSessionsValidAfter: cutoff, updatedAt: cutoff })
        .where(eq(organizations.id, input.orgId));
      await tx
        .insert(orgMembers)
        .values({ orgId: input.orgId, userId: newOwner.id, role: "owner" })
        .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.userId], set: { role: "owner", updatedAt: cutoff } });
      // The new owner's HOME becomes this workspace: the six runtime paths that resolve "the workspace's owner" through users.orgId
      // (agent first-turn / escalate / callback activity, workflow owner, AI plan, the Team page) then find them.
      await tx.update(users).set({ orgId: input.orgId, updatedAt: cutoff }).where(eq(users.id, newOwner.id));
      // The old owner keeps no tenant foothold here: its home moves (only if this was its home) to a workspace it already owns, and no membership.
      if (oldOwner.orgId === input.orgId) {
        const home = input.oldOwnerHomeOrgId;
        if (!home) throw new Refusal("old_owner_home_required");
        if (home === input.orgId) throw new Refusal("old_owner_home_is_this_workspace");
        const [owned] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.id, home), eq(organizations.ownerId, oldOwner.id)))
          .limit(1);
        const [ownerMember] = owned
          ? [owned]
          : await tx
              .select({ id: orgMembers.orgId })
              .from(orgMembers)
              .where(and(eq(orgMembers.orgId, home), eq(orgMembers.userId, oldOwner.id), eq(orgMembers.role, "owner")))
              .limit(1);
        if (!ownerMember) throw new Refusal("old_owner_home_not_owned");
        await tx.update(users).set({ orgId: home, updatedAt: cutoff }).where(eq(users.id, oldOwner.id));
      }
      await tx.delete(orgMembers).where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, oldOwner.id)));

      const after = await readState(tx, input.orgId, ids);
      if (!after) throw new Refusal("workspace_not_found");
      if (after.ownTier !== before.ownTier) throw new Refusal("tier_changed");
      if (!(await isOwnerLikeIn(tx, input.orgId, after, newOwner.id))) throw new Refusal("new_owner_not_owner_like");
      if (await isOwnerLikeIn(tx, input.orgId, after, oldOwner.id)) throw new Refusal("old_owner_still_owner_like");

      const actionId = await writeAudit(tx, {
        orgId: input.orgId,
        action: "ownership_transfer",
        outcome: "applied",
        actor: input.actor,
        before,
        after,
      });
      if (!actionId) throw new Refusal("audit_write_failed");
      return { alreadyApplied: false as const, actionId, validAfter: after.operatorSessionsValidAfter, from: oldOwner.id, to: newOwner.id };
    });

    if (!outcome.alreadyApplied) {
      try {
        // Observability only, after commit. No workflow subscribes to this event type.
        await emitSeldonEvent(
          "workspace.ownership_transferred",
          { actionId: outcome.actionId, fromOwnerId: outcome.from, toOwnerId: outcome.to },
          { orgId: input.orgId },
        );
      } catch {
        // The audit row is the record; the event is best-effort.
      }
    }
    return { ok: true, actionId: outcome.actionId, alreadyApplied: outcome.alreadyApplied, operatorSessionsValidAfter: outcome.validAfter };
  } catch (error) {
    return recordRefusal(input.orgId, "ownership_transfer", input.actor, error);
  }
}

async function latestAppliedTransfer(client: Client, orgId: string) {
  const [row] = await client
    .select({ id: workspaceAdminActions.id, after: workspaceAdminActions.after, before: workspaceAdminActions.before })
    .from(workspaceAdminActions)
    .where(and(eq(workspaceAdminActions.orgId, orgId), eq(workspaceAdminActions.action, "ownership_transfer"), eq(workspaceAdminActions.outcome, "applied")))
    .orderBy(desc(workspaceAdminActions.createdAt))
    .limit(1);
  if (!row) return null;
  const reverted = rowsOf<{ id: string }>(
    await client.execute(sql`select id from workspace_admin_actions where reverts_action_id = ${row.id}::uuid and outcome = 'applied' limit 1`),
  );
  return reverted.length ? null : row;
}

// ─── rollback ─────────────────────────────────────────────────────────────────

export type RollbackWorkspaceOwnershipInput = { orgId: string; transferActionId: string; actor: PlatformAdminActor; now?: () => Date };
export type RollbackWorkspaceOwnershipResult =
  | { ok: true; actionId: string; operatorSessionsValidAfter: string | null }
  | { ok: false; reason: string; actionId?: string };

/**
 * Reverse one applied transfer — only if the workspace is still exactly in the state that transfer left (owner, both users' homes and
 * roles, its memberships); any drift refuses, so a rollback never overwrites a later change. The operator-session cut-off is moved
 * FORWARD again (sessions minted between the transfer and the rollback end too) and is never restored, so revoked sessions stay dead.
 */
export async function rollbackWorkspaceOwnershipTransfer(input: RollbackWorkspaceOwnershipInput): Promise<RollbackWorkspaceOwnershipResult> {
  const now = input.now ?? (() => new Date());
  try {
    assertActor(input.actor);
    const result = await db.transaction(async (tx) => {
      const [transfer] = await tx
        .select({
          id: workspaceAdminActions.id,
          orgId: workspaceAdminActions.orgId,
          action: workspaceAdminActions.action,
          outcome: workspaceAdminActions.outcome,
          before: workspaceAdminActions.before,
          after: workspaceAdminActions.after,
        })
        .from(workspaceAdminActions)
        .where(eq(workspaceAdminActions.id, input.transferActionId))
        .limit(1);
      if (!transfer || transfer.orgId !== input.orgId || transfer.action !== "ownership_transfer" || transfer.outcome !== "applied") {
        throw new Refusal("transfer_not_found");
      }
      const already = rowsOf<{ id: string }>(
        await tx.execute(sql`select id from workspace_admin_actions where reverts_action_id = ${transfer.id}::uuid and outcome = 'applied' limit 1`),
      );
      if (already.length) throw new Refusal("already_reverted");

      const recordedBefore = transfer.before as unknown as OwnershipState;
      const recordedAfter = transfer.after as unknown as OwnershipState;
      const ids = recordedAfter.users.map((u) => u.id);
      const current = await lockAndRead(tx, input.orgId, ids);
      if (!current) throw new Refusal("workspace_not_found");
      if (comparable(current) !== comparable(recordedAfter)) throw new Refusal("state_drifted");

      const cutoff = now();
      await tx
        .update(organizations)
        .set({ ownerId: recordedBefore.ownerId, operatorSessionsValidAfter: cutoff, updatedAt: cutoff })
        .where(eq(organizations.id, input.orgId));
      for (const u of recordedBefore.users) {
        await tx.update(users).set({ orgId: u.orgId, role: u.role, updatedAt: cutoff }).where(eq(users.id, u.id));
      }
      // Memberships of the two users on this workspace go back to exactly what they were.
      await tx.delete(orgMembers).where(and(eq(orgMembers.orgId, input.orgId), inArray(orgMembers.userId, ids)));
      for (const m of recordedBefore.members.filter((m) => ids.includes(m.userId))) {
        await tx.insert(orgMembers).values({ orgId: input.orgId, userId: m.userId, role: m.role });
      }

      const restored = await readState(tx, input.orgId, ids);
      if (!restored || comparable(restored) !== comparable({ ...recordedBefore, operatorSessionsValidAfter: null })) {
        throw new Refusal("rollback_verification_failed");
      }
      const actionId = await writeAudit(tx, {
        orgId: input.orgId,
        action: "ownership_transfer_rollback",
        outcome: "applied",
        actor: input.actor,
        before: current,
        after: restored,
        revertsActionId: transfer.id,
      });
      if (!actionId) throw new Refusal("audit_write_failed");
      return { actionId, validAfter: restored.operatorSessionsValidAfter };
    });
    return { ok: true, actionId: result.actionId, operatorSessionsValidAfter: result.validAfter };
  } catch (error) {
    return recordRefusal(input.orgId, "ownership_transfer_rollback", input.actor, error, { revertsActionId: input.transferActionId });
  }
}
