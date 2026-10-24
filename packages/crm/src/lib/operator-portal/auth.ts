// ============================================================================
// v1.20.0 — operator-portal auth (sub-tenant operator login flow)
// ============================================================================
//
// White-label flagship surface. Audience: the HVAC owner / dentist /
// accountant / etc. who runs a workspace that an SF agency partner
// (Acme AI) has white-labeled to them. Distinct from:
//   - lib/portal/auth.ts (CUSTOMER portal — homeowners booking HVAC)
//   - NextAuth dashboard auth (SF AGENCY operator — Acme AI itself)
//
// Flow:
//   1. Agency operator (or workspace settings owner) calls
//      requestOperatorMagicLinkAction({ orgSlug, email })
//   2. We mint a JWT-style token (kind="magic", 15-min TTL) and email
//      a clickable link to /portal/<orgSlug>/magic?token=...
//   3. Operator clicks; the magic route calls
//      consumeOperatorMagicLink({ orgSlug, token }), which validates
//      the token, mints a session token (kind="session", 7-day TTL),
//      sets the sf_operator_session cookie, and redirects to
//      /portal/<orgSlug> (the operator dashboard)
//   4. Subsequent requests: requireOperatorSessionForOrg(orgSlug)
//      reads the cookie, validates kind="session", returns
//      { orgId, email } scoped to that workspace
//
// Plan gate: only Scale-tier workspaces (or workspaces under an
// active partner agency on Scale) can issue operator magic links.
// Free/Growth get a 422 with upgrade nudge.
//
// Security model:
//   - Magic-link token is JWT-only (no DB row). We accept the
//     trade-off that a leaked token is usable until expiry; mitigated
//     by 15-min TTL + HTTPS-only delivery + single-use semantic
//     (the magic route swaps it for a session cookie immediately,
//     so a re-click after first use lands them already-signed-in
//     anyway). v1.21 will add a one-shot DB nonce for true
//     single-use enforcement.
//   - Session cookie is HMAC-signed, httpOnly, sameSite=lax,
//     secure-in-prod. 7-day rolling exp.
//   - We DO NOT touch organizations.owner_id automatically — the
//     issuer must vouch for the email belonging to a person who
//     should manage this workspace. v1.21 adds an explicit "claim
//     workspace ownership" step on first sign-in.

"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { dbClockMs } from "@/db/clock";
import { agencySupportSessions, orgMembers, organizations, partnerAgencies, users, workspaceAdminActions } from "@/db/schema";
import { auth } from "@/auth";
import { selectPortalEmailTransport } from "@/lib/portal/email-transport";
import { assertWritable } from "@/lib/demo/server";
import { resolveInboxUrl } from "@/lib/utils/email-inbox";
import { emitSeldonEvent } from "@/lib/events/bus";
import { trackEvent } from "@/lib/analytics/track";
import {
  isEmailInAllowlist,
  operatorPortalOrigin,
  parseAdminAllowlist,
} from "./authorization";
import {
  OPERATOR_SESSION_COOKIE,
  isOperatorTokenRevoked,
  signOperatorToken,
  verifyOperatorToken,
  type OperatorTokenPayload,
} from "./session";
import {
  pickFromAddress,
  sendOperatorMagicLinkEmail,
} from "@/lib/emails/operator-magic-link";
import { getEffectiveBrandingForWorkspace } from "@/lib/partner-agencies/branding";
import { isAssignableMemberRole, loadWorkspaceRole, readStaffPermissionUserIds, type WorkspaceRole } from "@/lib/auth/workspace-role";
import { getCallerRoleIn } from "@/lib/auth/require-workspace-role";
import { getCurrentUser } from "@/lib/auth/helpers";
import { isAdminTokenUserId } from "@/lib/auth/admin-token";
import { isOperatorPortalUserId } from "@/lib/auth/operator-portal-context";

const MAGIC_LINK_TTL_MIN = 15;
const SESSION_TTL_DAYS = 7;

function getAppOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    "http://localhost:3000"
  );
}

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getOrgBySlug(orgSlug: string, client: DbClient = db) {
  const [org] = await client
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      ownerId: organizations.ownerId,
      parentAgencyId: organizations.parentAgencyId,
      operatorSessionsValidAfter: organizations.operatorSessionsValidAfter,
    })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  return org ?? null;
}

async function getUserEmailById(userId: string | null, client: DbClient = db): Promise<string | null> {
  if (!userId) return null;
  const [row] = await client
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

async function setOperatorSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(OPERATOR_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

// ─── server actions ────────────────────────────────────────────────────────

export type RequestOperatorMagicLinkResult =
  | { ok: true; expiresAt: string; sentTo: string; inboxUrl: string | null }
  | { ok: false; reason: string };

/**
 * Mint a magic-link token + email it to the operator.
 *
 * Idempotent + safe to call repeatedly: each call mints a fresh
 * token. Old tokens stay valid until their 15-min TTL elapses (no
 * DB row to invalidate; v1.21 will add nonce enforcement).
 *
 * Silent-no-op observability (v1.19 pattern): every short-circuit
 * path emits a structured warn so production monitoring can
 * attribute "no email arrived" reports.
 */
export async function requestOperatorMagicLinkAction(input: {
  orgSlug: string;
  email: string;
  invitedByName?: string;
}): Promise<RequestOperatorMagicLinkResult> {
  assertWritable();

  const orgSlug = input.orgSlug.trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const emailDomain = email.split("@")[1] ?? null;

  if (!orgSlug || !email) {
    return { ok: false, reason: "missing_required_field" };
  }

  const org = await getOrgBySlug(orgSlug);
  if (!org) {
    console.warn(
      `[operator-magic-link] silent_no_op: org_not_found org_slug=${orgSlug} email_domain=${emailDomain}`,
    );
    return { ok: true, expiresAt: "", sentTo: email, inboxUrl: resolveInboxUrl(email) };
  }

  // ── Authorization gate (security hotfix) ───────────────────────────────
  // Only the workspace owner, the parent-agency owner, or an SF
  // platform-admin (SF_SUPERADMIN_EMAILS) may receive an operator magic
  // link. Anyone else gets the SAME generic success shape as the
  // org-not-found path above — we never reveal whether an email is
  // authorized or a workspace exists (anti-enumeration) — but no token is
  // signed or sent. Pure decision logic + tests live in ./authorization.ts.
  // EPIC 2026-10-21 (Law 20): issuance, consumption and the per-request session gate all ask the SAME resolver
  // (loadWorkspaceRole by email), so they admit exactly the same people: owners (incl. creating operator, agency owner,
  // legacy home owner), admins and staff.
  const adminEmails = parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS);
  const authorized = Boolean(await loadWorkspaceRole(org.id, { email })) || isEmailInAllowlist(email, adminEmails);
  if (!authorized) {
    console.warn(
      `[operator-magic-link] silent_no_op: email_not_authorized org_id=${org.id} email_domain=${emailDomain}`,
    );
    return { ok: true, expiresAt: "", sentTo: email, inboxUrl: resolveInboxUrl(email) };
  }
  // EPIC 2026-10-20: platform authority is not tenant authority. An identity in SF_SUPERADMIN_EMAILS never gets a standing 7-day
  // session - also when the same identity owns or administers this workspace (Codex r1); it opens the audited 2-hour support
  // session instead (createAgencySupportSession). Same generic response shape as every other refusal (anti-enumeration).
  if (isEmailInAllowlist(email, adminEmails)) {
    console.warn(
      `[operator-magic-link] silent_no_op: platform_admin_uses_support_session org_id=${org.id} email_domain=${emailDomain}`,
    );
    return { ok: true, expiresAt: "", sentTo: email, inboxUrl: resolveInboxUrl(email) };
  }

  return issueOperatorMagicLink(org, orgSlug, email, input.invitedByName);
}

async function issueOperatorMagicLink(
  org: { id: string; name: string | null },
  orgSlug: string,
  email: string,
  invitedByName?: string,
): Promise<RequestOperatorMagicLinkResult> {
  const emailDomain = email.split("@")[1] ?? null;
  // Build the magic-link token + URL.
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + MAGIC_LINK_TTL_MIN * 60_000;
  const payload: OperatorTokenPayload = {
    orgId: org.id,
    email,
    exp: expiresAtMs,
    kind: "magic",
    iat: issuedAtMs,
  };
  const token = signOperatorToken(payload);
  // EPIC 2026-10-08: the link points at the workspace's own host (publicly reachable), not the access-restricted app host.
  const inviteUrl = new URL(
    `/portal/${orgSlug}/magic`,
    operatorPortalOrigin(orgSlug, process.env.WORKSPACE_BASE_DOMAIN, getAppOrigin()),
  );
  inviteUrl.searchParams.set("token", token);

  // Apply partner-agency branding to the email if the workspace is
  // under an active agency.
  const branding = await getEffectiveBrandingForWorkspace(org.id);

  // EPIC 2026-10-08: SMTP2GO when its key AND a verified sender (PORTAL_EMAIL_FROM) are set, else Resend (RESEND_API_KEY,
  // unchanged), else nothing can be sent. Same selection the customer portal code already uses (lib/portal/email-transport.ts).
  const selected = selectPortalEmailTransport(process.env);
  if (selected.transport === "none") {
    console.warn(
      `[operator-magic-link] silent_no_op: no_email_transport_configured org_id=${org.id} email_domain=${emailDomain}`,
    );
    return { ok: true, expiresAt: new Date(expiresAtMs).toISOString(), sentTo: email, inboxUrl: resolveInboxUrl(email) };
  }

  const fromAddress = selected.transport === "smtp2go" ? selected.from : pickFromAddress(process.env);

  const send = await sendOperatorMagicLinkEmail(
    {
      email,
      workspaceName: org.name ?? orgSlug,
      inviteUrl: inviteUrl.toString(),
      expiresInMinutes: MAGIC_LINK_TTL_MIN,
      brandName: branding?.is_white_label ? branding.brand_name : null,
      logoUrl: branding?.logo_url ?? null,
      supportUrl: branding?.is_white_label ? branding.support_url : null,
      invitedByName: invitedByName?.trim() || null,
    },
    { apiKey: selected.apiKey, fromAddress, transport: selected.transport },
  );

  if (!send.ok) {
    console.error(
      `[operator-magic-link] send_failed org_id=${org.id} email_domain=${emailDomain} status=${send.status} error=${send.error}`,
    );
    return { ok: false, reason: "email_send_failed" };
  }

  await emitSeldonEvent(
    "operator_portal.magic_link_issued",
    { email_domain: emailDomain ?? "(no_domain)" },
    { orgId: org.id },
  );

  trackEvent(
    "operator_magic_link_issued",
    { email_domain: emailDomain ?? "(no_domain)" },
    { orgId: org.id },
  );

  return {
    ok: true,
    expiresAt: new Date(expiresAtMs).toISOString(),
    sentTo: email,
    inboxUrl: resolveInboxUrl(email),
  };
}

// ─── invite a workspace operator (EPIC 2026-10-08) ─────────────────────────

export type InviteWorkspaceOperatorResult =
  | { ok: true; expiresAt: string; sentTo: string; inboxUrl: string | null }
  | { ok: false; reason: string };

/**
 * Called from Settings > Team by someone who is ALREADY authorised for this workspace (workspace owner, parent-agency owner or
 * platform admin; existing members cannot invite). It records the invitee as an admin member of THIS workspace only, then
 * sends the sign-in link. Because the invitee is now a member, they can request further links themselves from the portal
 * login page. Unlike requestOperatorMagicLinkAction (public, anti-enumeration), this one reports failures to the signed-in
 * inviter, who is already trusted.
 */
export async function inviteWorkspaceOperatorAction(input: {
  orgSlug: string;
  email: string;
  invitedByName?: string;
  /** EPIC 2026-10-21: the membership role to grant. Defaults to "staff"; "admin" must be chosen explicitly. */
  role?: string;
}): Promise<InviteWorkspaceOperatorResult> {
  assertWritable();

  const orgSlug = input.orgSlug.trim();
  const email = (input.email ?? "").trim().toLowerCase();
  if (!orgSlug || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "missing_required_field" };
  const role = input.role === undefined || input.role === "" ? "staff" : input.role;
  if (!isAssignableMemberRole(role)) return { ok: false, reason: "invalid_role" };

  // Member management is an OWNER-level right (native roles: an admin has full access except billing and member management).
  // EPIC 2026-10-21: one authority for invite, remove, role change and staff permissions — resolveMemberManager below.
  const m = await resolveMemberManager(orgSlug);
  if (!m.ok) return m;
  const org = m.manager.org;
  // EPIC 2026-10-20: a platform admin cannot be made a tenant member by invitation (itself, or any address that normalises to an
  // allowlisted one): that would turn platform authority into a standing tenant session. Its tenant access is the 2-hour support session.
  if (isEmailInAllowlist(email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) {
    return { ok: false, reason: "platform_admin_uses_support_session" };
  }

  // Find or create the invitee's user row (no password; they sign in by link), then add the membership for THIS workspace.
  let [invitee] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!invitee) {
    [invitee] = await db
      .insert(users)
      .values({ orgId: org.id, email, name: email.split("@")[0] || "Workspace operator", role: "member" })
      .returning({ id: users.id });
    if (invitee) {
      // This workspace is the new member's PRIMARY workspace, and the sign-in gates read onboarding state from it. The workspace is already
      // built, so mark it onboarded for them; without this a normal sign-in loops /dashboard -> /welcome -> /dashboard (the /welcome page
      // only redirects back). Same stamp the platform applies to new operators in markOperatorOnboarded; idempotent.
      await db
        .update(organizations)
        .set({
          soulCompletedAt: sql`COALESCE(${organizations.soulCompletedAt}, now())`,
          settings: sql`COALESCE(${organizations.settings}, '{}'::jsonb) || '{"welcomeShown": true}'::jsonb`,
        })
        .where(eq(organizations.id, org.id));
      await db.update(users).set({ planId: "free" }).where(and(eq(users.id, invitee.id), isNull(users.planId)));
    }
  }
  if (!invitee) return { ok: false, reason: "invite_failed" };
  // EPIC 2026-10-21: the invite grants the chosen role (default staff, never admin implicitly). An EXISTING membership is
  // left exactly as it is — re-inviting never silently promotes or demotes anyone; role changes go through Settings > Team.
  await db.insert(orgMembers).values({ orgId: org.id, userId: invitee.id, role }).onConflictDoNothing({ target: [orgMembers.orgId, orgMembers.userId] });

  return issueOperatorMagicLink(org, orgSlug, email, input.invitedByName);
}

// ─── member management: remove, change role, staff permissions (EPIC 2026-10-21) ──────────────────────────
//
// One authority for inviting and managing (an OWNER-level right): whoever the per-request resolver says is OWNER of this
// workspace — in EITHER realm (app sign-in or magic-link session) — or a platform admin on the app sign-in. Admins and
// staff cannot manage members. Every change takes effect on the member's NEXT request,
// in both realms, because the role is re-read per request (lib/auth/workspace-role.ts); nothing is cached in a token.
// Each applied change is recorded in workspace_admin_actions (existing table, no DDL).

export type MemberManagementResult = { ok: true } | { ok: false; reason: string };

type MemberManager = { org: NonNullable<Awaited<ReturnType<typeof getOrgBySlug>>>; actorUserId: string; actorEmail: string };

async function resolveMemberManager(orgSlug: string): Promise<{ ok: true; manager: MemberManager } | { ok: false; reason: string }> {
  const caller = await getCurrentUser();
  const actorEmail = String(caller?.email ?? "").trim().toLowerCase();
  if (!caller?.id || !actorEmail || isAdminTokenUserId(caller.id)) return { ok: false, reason: "not_signed_in" };
  const org = await getOrgBySlug((orgSlug ?? "").trim());
  if (!org) return { ok: false, reason: "workspace_not_found" };
  // Owner of THIS workspace, read per request (magic-link sessions only ever hold a role in their own workspace).
  if ((await getCallerRoleIn(org.id)) === "owner") {
    const actor = isOperatorPortalUserId(caller.id)
      ? await loadWorkspaceRole(org.id, { email: actorEmail })
      : { userId: caller.id };
    if (actor?.userId) return { ok: true, manager: { org, actorUserId: actor.userId, actorEmail } };
  }
  // A platform admin on the app sign-in (unchanged authority; never through a magic-link or support session).
  if (!isOperatorPortalUserId(caller.id) && isEmailInAllowlist(actorEmail, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) {
    return { ok: true, manager: { org, actorUserId: caller.id, actorEmail } };
  }
  return { ok: false, reason: "not_authorized_for_workspace" };
}

/** The member row a manager may change: an existing membership that is not an ownership holder. */
async function loadManageableMember(org: MemberManager["org"], userId: string): Promise<{ ok: true; role: string } | { ok: false; reason: string }> {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return { ok: false, reason: "member_not_found" };
  const [member] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) return { ok: false, reason: "member_not_found" };
  // Ownership is only ever changed by the audited ownership transfer, never here.
  const resolved = await loadWorkspaceRole(org.id, { userId });
  if (member.role === "owner" || org.ownerId === userId || resolved?.role === "owner") return { ok: false, reason: "cannot_change_owner" };
  return { ok: true, role: member.role };
}

async function auditMemberChange(
  manager: MemberManager,
  action: "member_removed" | "member_role_changed" | "member_permission_changed",
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  await db.insert(workspaceAdminActions).values({
    orgId: manager.org.id,
    action,
    outcome: "applied",
    actorUserId: manager.actorUserId,
    actorEmail: manager.actorEmail,
    before,
    after,
  });
}

/**
 * Codex r4: add or remove ONE member in settings.staffAccess.askEmployeeUserIds under a row lock (FOR UPDATE), so two
 * concurrent changes for different members can never restore a stale list. Only that key is replaced; every other
 * settings key is preserved by the jsonb merge. Returns whether the member held the permission before and after.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function changeAskEmployeePermission(orgId: string, userId: string, enabled: boolean, existingTx?: Tx): Promise<{ before: boolean; after: boolean; notMember?: boolean }> {
  const run = async (tx: Tx) => {
    await tx.execute(sql`select id from organizations where id = ${orgId}::uuid for update`);
    // Codex r5: membership is re-checked UNDER the lock that removal also takes, so an enable racing a removal can
    // never re-grant the permission to someone who is no longer a member.
    if (enabled) {
      const [member] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1);
      if (!member) return { before: false, after: false, notMember: true };
    }
    const [row] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const current = readStaffPermissionUserIds(row?.settings, "askEmployee");
    const next = enabled ? Array.from(new Set([...current, userId])) : current.filter((id) => id !== userId);
    if (next.length !== current.length || next.some((id, i) => id !== current[i])) {
      await tx
        .update(organizations)
        .set({
          settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('staffAccess', coalesce(${organizations.settings} -> 'staffAccess', '{}'::jsonb) || jsonb_build_object('askEmployeeUserIds', ${JSON.stringify(next)}::jsonb))`,
        })
        .where(eq(organizations.id, orgId));
    }
    return { before: current.includes(userId), after: next.includes(userId) };
  };
  return existingTx ? run(existingTx) : db.transaction(run);
}

/** Owner-only: remove a member. Their sessions (magic-link and app sign-in) are refused from their next request. */
export async function removeWorkspaceMemberAction(input: { orgSlug: string; userId: string }): Promise<MemberManagementResult> {
  assertWritable();
  const m = await resolveMemberManager(input.orgSlug);
  if (!m.ok) return m;
  const target = await loadManageableMember(m.manager.org, input.userId);
  if (!target.ok) return target;
  // One transaction under the workspace row lock: the membership goes and every staff permission the member held is
  // dropped together, so a later re-invite starts with every permission OFF (Codex r5: no race with an enable).
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from organizations where id = ${m.manager.org.id}::uuid for update`);
    await tx.delete(orgMembers).where(and(eq(orgMembers.orgId, m.manager.org.id), eq(orgMembers.userId, input.userId)));
    await changeAskEmployeePermission(m.manager.org.id, input.userId, false, tx);
  });
  await auditMemberChange(m.manager, "member_removed", { userId: input.userId, role: target.role }, { userId: input.userId, role: null });
  return { ok: true };
}

/** Owner-only: change a member's role between staff and admin. Applies on the member's next request. */
export async function setWorkspaceMemberRoleAction(input: { orgSlug: string; userId: string; role: string }): Promise<MemberManagementResult> {
  assertWritable();
  if (!isAssignableMemberRole(input.role)) return { ok: false, reason: "invalid_role" };
  const m = await resolveMemberManager(input.orgSlug);
  if (!m.ok) return m;
  const target = await loadManageableMember(m.manager.org, input.userId);
  if (!target.ok) return target;
  if (target.role === input.role) return { ok: true };
  await db
    .update(orgMembers)
    .set({ role: input.role, updatedAt: new Date() })
    .where(and(eq(orgMembers.orgId, m.manager.org.id), eq(orgMembers.userId, input.userId)));
  await auditMemberChange(m.manager, "member_role_changed", { userId: input.userId, role: target.role }, { userId: input.userId, role: input.role });
  return { ok: true };
}

/** Owner-only: switch a member's "Ask an employee" permission (default OFF). Stored in organizations.settings.staffAccess. */
export async function setMemberAskEmployeePermissionAction(input: { orgSlug: string; userId: string; enabled: boolean }): Promise<MemberManagementResult> {
  assertWritable();
  const m = await resolveMemberManager(input.orgSlug);
  if (!m.ok) return m;
  const target = await loadManageableMember(m.manager.org, input.userId);
  if (!target.ok) return target;
  const changed = await changeAskEmployeePermission(m.manager.org.id, input.userId, input.enabled === true);
  if (changed.notMember) return { ok: false, reason: "member_not_found" };
  await auditMemberChange(
    m.manager,
    "member_permission_changed",
    { userId: input.userId, askEmployee: changed.before },
    { userId: input.userId, askEmployee: changed.after },
  );
  return { ok: true };
}

// ─── magic-link consumption (called by /portal/[orgSlug]/magic route) ──────

export async function consumeOperatorMagicLink(input: {
  orgSlug: string;
  token: string;
}): Promise<
  | { ok: true; orgId: string; email: string }
  | { ok: false; reason: string }
> {
  const orgSlug = input.orgSlug.trim();
  const token = input.token.trim();

  if (!orgSlug || !token) {
    return { ok: false, reason: "missing_token_or_slug" };
  }

  const verified = verifyOperatorToken(token);
  if (!verified || verified.kind !== "magic") {
    return { ok: false, reason: "invalid_or_expired_token" };
  }

  // EPIC 2026-10-20 (Codex r1 BLOCKER): the decision and the new session's timestamp are serialised against an ownership transfer.
  // The workspace row is share-locked for the whole decision (transferWorkspaceOwnership takes FOR UPDATE on it), so a transfer
  // either committed before - and the fresh owner and cut-off read below see it - or waits until this session exists and then cuts
  // it off with a later cut-off. Every read runs on this transaction (one connection, Codex r2), and the session's iat comes from the
  // DATABASE clock under the lock, the same clock the transfer's cut-off uses, so lock order is also timestamp order (Codex r2).
  const decided = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from organizations where id = ${verified.orgId}::uuid for share`);
    return decideOperatorMagicLinkConsume(orgSlug, verified, tx);
  });
  if (!decided.ok) return decided;
  await setOperatorSessionCookie(decided.sessionToken);
  const org = decided.org;

  await emitSeldonEvent(
    "operator_portal.session_established",
    { email_domain: verified.email.split("@")[1] ?? "(no_domain)" },
    { orgId: org.id },
  );

  trackEvent(
    "operator_portal_login",
    { login_method: "magic_link" },
    { orgId: org.id },
  );

  return { ok: true, orgId: org.id, email: verified.email };
}

async function decideOperatorMagicLinkConsume(
  orgSlug: string,
  verified: OperatorTokenPayload,
  client: DbClient,
): Promise<{ ok: true; org: { id: string }; sessionToken: string } | { ok: false; reason: string }> {
  const org = await getOrgBySlug(orgSlug, client);
  if (!org || org.id !== verified.orgId) {
    return { ok: false, reason: "org_mismatch" };
  }
  // EPIC 2026-10-20: a link issued at or before the workspace's operator-session cut-off is dead, even if unused and unexpired.
  if (isOperatorTokenRevoked(verified, org.operatorSessionsValidAfter)) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }
  // Re-authorise at consumption (a link outlives changes to who may hold it): the email must hold TENANT authority here — owner,
  // parent-agency owner or owner/admin member. Platform-admin authority alone never becomes a 7-day session.
  // EPIC 2026-10-21 (Law 20): the same resolver as issuance and the per-request gate, read on this transaction.
  if (!(await loadWorkspaceRole(org.id, { email: verified.email }, client))) {
    return { ok: false, reason: "not_authorized_for_workspace" };
  }
  // Codex r1: a platform admin never turns a link into a standing session, even when it also holds tenant authority here.
  if (isEmailInAllowlist(verified.email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) {
    return { ok: false, reason: "not_authorized_for_workspace" };
  }

  // Mint a session token (long TTL); the caller sets the cookie after the decision commits. iat = database clock (see above).
  const sessionIssuedAt = await dbClockMs(client);
  const sessionExp = sessionIssuedAt + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const sessionToken = signOperatorToken({
    orgId: org.id,
    email: verified.email,
    exp: sessionExp,
    kind: "session",
    supportOriginUserId: null,
    iat: sessionIssuedAt,
  });
  return { ok: true, org: { id: org.id }, sessionToken };
}

// ─── session reads ─────────────────────────────────────────────────────────

export async function getOperatorSessionForOrg(orgSlug: string): Promise<
  | { orgId: string; orgSlug: string; email: string; supportOriginUserId: string | null; supportSessionId: string | null; role: WorkspaceRole }
  | null
> {
  const org = await getOrgBySlug(orgSlug);
  if (!org) return null;

  const cookieStore = await cookies();
  const token = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  const verified = verifyOperatorToken(token);
  if (!verified || verified.kind !== "session" || verified.orgId !== org.id) {
    return null;
  }
  if (isOperatorTokenRevoked(verified, org.operatorSessionsValidAfter)) return null;
  if (verified.supportOriginUserId) {
    if (!verified.supportSessionId) return null;
    const [activeAudit] = await db.select({ id: agencySupportSessions.id })
      .from(agencySupportSessions)
      .where(and(
        eq(agencySupportSessions.id, verified.supportSessionId),
        eq(agencySupportSessions.workspaceId, org.id),
        eq(agencySupportSessions.originUserId, verified.supportOriginUserId),
        isNull(agencySupportSessions.endedAt),
      )).limit(1);
    if (!activeAudit) return null;
  }
  // Codex r1: a platform admin's tenant access is only ever the audited support session; any other session for it is refused.
  if (!verified.supportOriginUserId && isEmailInAllowlist(verified.email, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) return null;
  // EPIC 2026-10-21: re-read the person's standing here on every request (removal ends the session at once).
  let role: WorkspaceRole = "admin";
  if (!verified.supportOriginUserId) {
    const resolved = await loadWorkspaceRole(org.id, { email: verified.email });
    if (!resolved) return null;
    role = resolved.role;
  }

  return {
    orgId: org.id,
    orgSlug: org.slug,
    email: verified.email,
    supportOriginUserId: verified.supportOriginUserId ?? null,
    supportSessionId: verified.supportSessionId ?? null,
    role,
  };
}

export async function requireOperatorSessionForOrg(orgSlug: string) {
  const session = await getOperatorSessionForOrg(orgSlug);
  if (!session) {
    redirect(`/portal/${orgSlug}/login`);
  }
  return session;
}

export async function clearOperatorSessionAction(orgSlug: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(OPERATOR_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  redirect(`/portal/${orgSlug}/login`);
}
