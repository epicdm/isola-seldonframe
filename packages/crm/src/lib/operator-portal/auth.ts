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
import { orgMembers, organizations, partnerAgencies, users } from "@/db/schema";
import { auth } from "@/auth";
import { selectPortalEmailTransport } from "@/lib/portal/email-transport";
import { assertWritable } from "@/lib/demo/server";
import { resolveInboxUrl } from "@/lib/utils/email-inbox";
import { emitSeldonEvent } from "@/lib/events/bus";
import { trackEvent } from "@/lib/analytics/track";
import {
  isEmailAuthorizedForWorkspace,
  operatorPortalOrigin,
  parseAdminAllowlist,
} from "./authorization";
import {
  OPERATOR_SESSION_COOKIE,
  signOperatorToken,
  verifyOperatorToken,
  type OperatorTokenPayload,
} from "./session";
import {
  pickFromAddress,
  sendOperatorMagicLinkEmail,
} from "@/lib/emails/operator-magic-link";
import { getEffectiveBrandingForWorkspace } from "@/lib/partner-agencies/branding";

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

async function getOrgBySlug(orgSlug: string) {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      ownerId: organizations.ownerId,
      parentAgencyId: organizations.parentAgencyId,
    })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  return org ?? null;
}

async function getUserEmailById(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Resolve the two human owner emails that gate operator magic-link
 * issuance for a workspace: the workspace owner and the parent-agency
 * owner. (The platform-admin allowlist is resolved separately from env.)
 *
 * Agency ownership is polymorphic (see partner-agencies schema): an agency
 * is anchored to a user (ownerUserId) or, for anonymous workspaces, to a
 * workspace (ownerWorkspaceId). We resolve a human email from whichever is
 * set — ownerUserId first, then the owning workspace's owner.
 */
async function resolveWorkspaceOwnerEmails(org: {
  id: string;
  ownerId: string | null;
  parentAgencyId: string | null;
}): Promise<{ ownerEmail: string | null; agencyOwnerEmail: string | null; memberEmails: string[] }> {
  const ownerEmail = await getUserEmailById(org.ownerId);

  // EPIC 2026-10-08: people already added to this workspace as owner/admin members.
  const memberRows = await db
    .select({ email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, org.id), inArray(orgMembers.role, ["owner", "admin"])));
  const memberEmails = memberRows.map((r) => r.email).filter((e): e is string => Boolean(e));

  let agencyOwnerEmail: string | null = null;
  if (org.parentAgencyId) {
    const [agency] = await db
      .select({
        ownerUserId: partnerAgencies.ownerUserId,
        ownerWorkspaceId: partnerAgencies.ownerWorkspaceId,
      })
      .from(partnerAgencies)
      .where(eq(partnerAgencies.id, org.parentAgencyId))
      .limit(1);
    if (agency?.ownerUserId) {
      agencyOwnerEmail = await getUserEmailById(agency.ownerUserId);
    } else if (agency?.ownerWorkspaceId) {
      const [ownerWs] = await db
        .select({ ownerId: organizations.ownerId })
        .from(organizations)
        .where(eq(organizations.id, agency.ownerWorkspaceId))
        .limit(1);
      agencyOwnerEmail = await getUserEmailById(ownerWs?.ownerId ?? null);
    }
  }

  return { ownerEmail, agencyOwnerEmail, memberEmails };
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
  const { ownerEmail, agencyOwnerEmail, memberEmails } = await resolveWorkspaceOwnerEmails(org);
  const adminEmails = parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS);
  const authorized = isEmailAuthorizedForWorkspace(email, {
    ownerEmail,
    agencyOwnerEmail,
    adminEmails,
    memberEmails,
  });
  if (!authorized) {
    console.warn(
      `[operator-magic-link] silent_no_op: email_not_authorized org_id=${org.id} email_domain=${emailDomain}`,
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
  const expiresAtMs = Date.now() + MAGIC_LINK_TTL_MIN * 60_000;
  const payload: OperatorTokenPayload = {
    orgId: org.id,
    email,
    exp: expiresAtMs,
    kind: "magic",
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
}): Promise<InviteWorkspaceOperatorResult> {
  assertWritable();
  const session = await auth();
  const inviterEmail = session?.user?.email?.trim().toLowerCase() ?? "";
  if (!session?.user?.id || !inviterEmail) return { ok: false, reason: "not_signed_in" };

  const orgSlug = input.orgSlug.trim();
  const email = (input.email ?? "").trim().toLowerCase();
  if (!orgSlug || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "missing_required_field" };

  const org = await getOrgBySlug(orgSlug);
  if (!org) return { ok: false, reason: "workspace_not_found" };

  // Member management is an OWNER-level right (native roles: an admin has full access except billing and member management), so the
  // inviter must be the workspace owner, the parent-agency owner or a platform admin. Existing members are deliberately NOT accepted here
  // (they may still sign in and request their own links through requestOperatorMagicLinkAction).
  const { ownerEmail, agencyOwnerEmail } = await resolveWorkspaceOwnerEmails(org);
  const allowed = isEmailAuthorizedForWorkspace(inviterEmail, {
    ownerEmail,
    agencyOwnerEmail,
    adminEmails: parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS),
  });
  if (!allowed) return { ok: false, reason: "not_authorized_for_workspace" };

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
  await db.insert(orgMembers).values({ orgId: org.id, userId: invitee.id, role: "admin" }).onConflictDoNothing({ target: [orgMembers.orgId, orgMembers.userId] });

  return issueOperatorMagicLink(org, orgSlug, email, input.invitedByName);
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

  const org = await getOrgBySlug(orgSlug);
  if (!org || org.id !== verified.orgId) {
    return { ok: false, reason: "org_mismatch" };
  }

  // Mint a session token (long TTL) and set the cookie.
  const sessionExp = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const sessionToken = signOperatorToken({
    orgId: org.id,
    email: verified.email,
    exp: sessionExp,
    kind: "session",
    supportOriginUserId: verified.supportOriginUserId ?? null,
  });
  await setOperatorSessionCookie(sessionToken);

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

// ─── session reads ─────────────────────────────────────────────────────────

export async function getOperatorSessionForOrg(orgSlug: string): Promise<
  | { orgId: string; orgSlug: string; email: string; supportOriginUserId: string | null }
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

  return {
    orgId: org.id,
    orgSlug: org.slug,
    email: verified.email,
    supportOriginUserId: verified.supportOriginUserId ?? null,
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
