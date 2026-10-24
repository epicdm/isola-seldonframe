// ============================================================================
// v1.22.0 — agency support sessions
// ============================================================================
//
// Two server actions:
//
//   - createAgencySupportSession({ workspaceId })
//     Called from the agency-side dashboard's "Open <workspace> portal"
//     button. Verifies the calling user owns the workspace's
//     parent_agency_id (or matches the agency's owner_workspace_id
//     for v1.19 polymorphic ownership). Mints a short-lived
//     OperatorTokenPayload (kind="session", supportOriginUserId set,
//     2-hour TTL). Returns { url, sessionId } — the URL is a
//     /portal/<slug>/support-magic?token=... that consumes the
//     token and sets the operator session cookie. Returns the
//     audit-row id for v1.23 ended_at tracking.
//
//   - consumeAgencySupportSession({ orgSlug, token })
//     Verifies the token, sets the operator session cookie, and
//     returns the redirect target. Used by the support-magic route.
//
// Audit: every session start writes an agency_support_sessions row.
// The token binds to that row; each dashboard request checks that it remains
// active, and the dashboard banner can explicitly end it.

"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { dbClockMs } from "@/db/clock";
import {
  contacts,
  agencySupportSessions,
  organizations,
  partnerAgencies,
} from "@/db/schema";
import { auth } from "@/auth";
import { assertWritable } from "@/lib/demo/server";
import { emitSeldonEvent } from "@/lib/events/bus";
import { trackEvent } from "@/lib/analytics/track";
import {
  OPERATOR_SESSION_COOKIE,
  isOperatorTokenRevoked,
  signOperatorToken,
  verifyOperatorToken,
} from "./session";
import { isEmailInAllowlist, normalizeEmail, parseAdminAllowlist } from "./authorization";

const SUPPORT_SESSION_TTL_HOURS = 2;

function getAppOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    "http://localhost:3000"
  );
}

export type CreateSupportSessionResult =
  | { ok: true; url: string; sessionId: string; expiresAt: string }
  | { ok: false; reason: string };

export async function createAgencySupportSession(input: {
  workspaceId: string;
  /** Optional tenant-owned CRM contact to open immediately after support entry. */
  contactId?: string;
}): Promise<CreateSupportSessionResult> {
  assertWritable();

  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, reason: "unauthorized" };
  }
  const callerUserId = session.user.id;

  if (!input.workspaceId) {
    return { ok: false, reason: "missing_required_field" };
  }

  // Resolve the workspace + its parent agency.
  const [workspace] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      parentAgencyId: organizations.parentAgencyId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.workspaceId))
    .limit(1);
  if (!workspace) {
    return { ok: false, reason: "workspace_not_found" };
  }
  if (!workspace.parentAgencyId) {
    // EPIC 2026-10-20: the ONLY tenant access a platform admin has to a workspace outside any agency (Port
    // dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20). Same 2-hour token, same audit row (agency_id NULL) and
    // event; the actor is identified by user id and email. Everyone else is refused exactly as before.
    const callerEmail = normalizeEmail(session.user.email);
    if (!callerEmail || !isEmailInAllowlist(callerEmail, parseAdminAllowlist(process.env.SF_SUPERADMIN_EMAILS))) {
      return { ok: false, reason: "workspace_not_under_an_agency" };
    }
    return mintSupportSession({ workspace, agencyId: null, callerUserId, actorEmail: callerEmail, contactId: input.contactId });
  }

  const [agency] = await db
    .select({
      id: partnerAgencies.id,
      ownerUserId: partnerAgencies.ownerUserId,
      ownerWorkspaceId: partnerAgencies.ownerWorkspaceId,
      status: partnerAgencies.status,
    })
    .from(partnerAgencies)
    .where(eq(partnerAgencies.id, workspace.parentAgencyId))
    .limit(1);
  if (!agency) {
    return { ok: false, reason: "agency_not_found" };
  }
  if (agency.status !== "active") {
    return { ok: false, reason: "agency_not_active" };
  }

  // Authorize: caller must own the agency. Polymorphic check (v1.19) —
  // either ownerUserId match OR caller's workspaces include
  // ownerWorkspaceId. For v1.22 we accept the user-id match path
  // only (the dashboard caller is always a real users-row).
  if (agency.ownerUserId !== callerUserId) {
    return { ok: false, reason: "not_agency_owner" };
  }

  return mintSupportSession({ workspace, agencyId: agency.id, callerUserId, actorEmail: null, contactId: input.contactId });
}

async function mintSupportSession(input: {
  workspace: { id: string; slug: string };
  agencyId: string | null;
  callerUserId: string;
  /** Set for the platform-admin branch (agencyId null): the actor's email is recorded on the audit row. */
  actorEmail: string | null;
  contactId?: string;
}): Promise<CreateSupportSessionResult> {
  const { workspace, agencyId, callerUserId } = input;
  if (input.contactId) {
    const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(
      eq(contacts.id, input.contactId),
      eq(contacts.orgId, workspace.id),
    )).limit(1);
    if (!contact) return { ok: false, reason: "contact_not_in_workspace" };
  }
  // EPIC 2026-10-20 (Codex r3): minted under a share lock on the workspace row with iat from the DATABASE clock - the clock and lock an
  // ownership transfer uses for its cut-off - and recorded in the same transaction, so a support token is either cut off by a later
  // transfer or issued after it; never stamped by a fast application clock past a cut-off it should fall under.
  const minted = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from organizations where id = ${workspace.id}::uuid for share`);
    // Mint the support-session token.
    const issuedAtMs = await dbClockMs(tx);
    const expiresAtMs =
      issuedAtMs + SUPPORT_SESSION_TTL_HOURS * 60 * 60 * 1000;
    // Use a synthetic email for the support session — the operator
    // portal session needs an email field, but we don't want to leak
    // the agency operator's primary email into the workspace. Instead
    // we use a deterministic synthetic ('support+<agency>@' style)
    // that's distinguishable in audit logs.
    const supportEmail = agencyId
      ? `support+${agencyId.slice(0, 8)}@seldonframe-agency.local`
      : `support+platform-${callerUserId.slice(0, 8)}@seldonframe-agency.local`;
    // Audit row. The audit row is the precondition for the session: no row, no link.
    const [auditRow] = await tx
      .insert(agencySupportSessions)
      .values({
        agencyId,
        workspaceId: workspace.id,
        originUserId: callerUserId,
        notes: input.actorEmail ? `platform_support actor_email=${input.actorEmail}` : null,
      })
      .returning({ id: agencySupportSessions.id });
    const sessionToken = auditRow?.id ? signOperatorToken({
      orgId: workspace.id,
      email: supportEmail,
      exp: expiresAtMs,
      kind: "session",
      supportOriginUserId: callerUserId,
      supportSessionId: auditRow.id,
      iat: issuedAtMs,
    }) : null;
    return { expiresAtMs, sessionToken, auditRow };
  });
  const { expiresAtMs, sessionToken, auditRow } = minted;
  if (!auditRow?.id || !sessionToken) {
    return { ok: false, reason: "audit_write_failed" };
  }

  await emitSeldonEvent(
    "agency.support_session_started",
    {
      agencyId: agencyId ?? "(platform)",
      workspaceId: workspace.id,
      originUserId: callerUserId,
      sessionId: auditRow.id,
      ...(input.actorEmail ? { actorEmail: input.actorEmail, platformSupport: true } : {}),
    },
    { orgId: workspace.id },
  );

  trackEvent(
    "agency_support_session_started",
    { agency_id: agencyId ?? "(platform)" },
    { orgId: workspace.id },
  );

  // Build the URL the caller opens. The support-magic route consumes
  // the token + sets the cookie + redirects to /portal/<slug>.
  const url = new URL(
    `/portal/${workspace.slug}/support-magic`,
    getAppOrigin(),
  );
  url.searchParams.set("token", sessionToken);
  if (input.contactId) url.searchParams.set("next", `/contacts/${input.contactId}`);

  return {
    ok: true,
    url: url.toString(),
    sessionId: auditRow.id,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function consumeAgencySupportSession(input: {
  orgSlug: string;
  token: string;
  nextPath?: string | null;
}): Promise<
  | { ok: true; redirectTo: string }
  | { ok: false; reason: string }
> {
  if (!input.orgSlug || !input.token) {
    return { ok: false, reason: "missing_token_or_slug" };
  }

  const verified = verifyOperatorToken(input.token);
  if (
    !verified ||
    verified.kind !== "session" ||
    !verified.supportOriginUserId ||
    !verified.supportSessionId
  ) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }

  // Verify the workspace slug matches.
  const [workspace] = await db
    .select({ id: organizations.id, operatorSessionsValidAfter: organizations.operatorSessionsValidAfter })
    .from(organizations)
    .where(eq(organizations.slug, input.orgSlug))
    .limit(1);
  if (!workspace || workspace.id !== verified.orgId) {
    return { ok: false, reason: "workspace_slug_mismatch" };
  }
  if (isOperatorTokenRevoked(verified, workspace.operatorSessionsValidAfter)) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }
  const [activeAudit] = await db
    .select({ id: agencySupportSessions.id })
    .from(agencySupportSessions)
    .where(and(
      eq(agencySupportSessions.id, verified.supportSessionId),
      eq(agencySupportSessions.workspaceId, workspace.id),
      eq(agencySupportSessions.originUserId, verified.supportOriginUserId),
      isNull(agencySupportSessions.endedAt),
    ))
    .limit(1);
  if (!activeAudit) return { ok: false, reason: "support_session_inactive" };

  let redirectTo = "/dashboard";
  if (input.nextPath) {
    const match = /^\/contacts\/([A-Za-z0-9_-]+)$/.exec(input.nextPath);
    if (!match) return { ok: false, reason: "invalid_support_redirect" };
    const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(
      eq(contacts.id, match[1]),
      eq(contacts.orgId, workspace.id),
    )).limit(1);
    if (!contact) return { ok: false, reason: "contact_not_in_workspace" };
    redirectTo = `/contacts/${contact.id}`;
  }

  // Set the operator session cookie. Same shape as a normal magic-
  // link consume — the supportOriginUserId carried in the token
  // surfaces the yellow banner in the operator portal layout.
  const cookieStore = await cookies();
  cookieStore.set(OPERATOR_SESSION_COOKIE, input.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Cookie expires when the JWT does. Since exp is on the token
    // itself, we use a generous max-age and let verify reject on
    // expiry.
    maxAge: SUPPORT_SESSION_TTL_HOURS * 60 * 60,
  });

  // v1.25.0 — agency support session lands at /dashboard (same admin
  // shell as a normal operator login), with the supportOriginUserId
  // surfaced on the synthetic session for banner rendering.
  return {
    ok: true,
    redirectTo,
  };
}

/** End exactly the audited support session represented by this cookie. */
export async function exitOperatorSupportSessionAction(): Promise<void> {
  "use server";
  assertWritable();
  const cookieStore = await cookies();
  const token = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  const verified = verifyOperatorToken(token);
  if (
    !verified ||
    verified.kind !== "session" ||
    !verified.supportSessionId ||
    !verified.supportOriginUserId
  ) {
    redirect("/super-admin/workspaces");
  }
  const [ended] = await db
    .update(agencySupportSessions)
    .set({ endedAt: sql`now()` })
    .where(and(
      eq(agencySupportSessions.id, verified.supportSessionId),
      eq(agencySupportSessions.workspaceId, verified.orgId),
      eq(agencySupportSessions.originUserId, verified.supportOriginUserId),
      isNull(agencySupportSessions.endedAt),
    ))
    .returning({ id: agencySupportSessions.id, agencyId: agencySupportSessions.agencyId });
  cookieStore.set(OPERATOR_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  redirect(ended?.agencyId ? "/dashboard" : "/super-admin/workspaces");
}
