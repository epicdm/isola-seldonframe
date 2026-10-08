// ============================================================================
// Operator-portal magic-link authorization (pure logic, no I/O).
// ============================================================================
//
// Security hotfix: previously requestOperatorMagicLinkAction trusted any
// email typed into /portal/<orgSlug>/login and would mint + send a magic
// link to it, letting ANYONE sign into ANY workspace's operator portal.
//
// This module holds the pure decision logic for "is this email allowed to
// receive an operator magic link for this workspace". It deliberately does
// NO database or env access so it can be unit-tested in isolation (node:test
// via tsx; `pnpm test:unit`). The "use server" action in ./auth.ts resolves
// the three email sources (workspace owner, parent-agency owner, platform-
// admin allowlist) from the DB / env and feeds them in here.
//
// A magic link is issued ONLY if the (normalized) submitted email matches
// one of:
//   1. the workspace owner's email  (organizations.ownerId -> users.email)
//   2. the parent-agency owner's email
//      (organizations.parentAgencyId -> partner_agencies owner -> users.email)
//   3. a platform-admin allowlist entry (SF_SUPERADMIN_EMAILS — the same
//      allowlist enforced by lib/auth/super-admin.ts / isSuperAdminUser).
//
// All comparisons are case-insensitive and whitespace-insensitive. Null /
// empty inputs are denied. The caller (auth.ts) is responsible for the
// anti-enumeration response shape — this helper only answers true/false.

/** Trim + lowercase an email-ish string; returns "" for null/empty/blank. */
export function normalizeEmail(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * Parse the SF_SUPERADMIN_EMAILS-style allowlist string into a normalized
 * list. Comma-separated, whitespace-tolerant, blanks dropped, lowercased.
 *
 * This is the single parsing implementation shared with
 * lib/auth/super-admin.ts so the platform-admin allowlist has exactly one
 * source of truth for its format.
 */
export function parseAdminAllowlist(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

/** True iff `email` (normalized) is in `allowlist` (already-parsed, e.g. from parseAdminAllowlist). Empty/null email is never in it. */
export function isEmailInAllowlist(email: string | null | undefined, allowlist: readonly string[]): boolean {
  const candidate = normalizeEmail(email);
  if (!candidate) return false;
  return allowlist.some((entry) => normalizeEmail(entry) === candidate);
}

/**
 * EPIC 2026-10-08: the platform-admin limit bypass (lib/tier/limits.ts) applies ONLY to the platform operator's own HOME workspace,
 * never to a client workspace the operator merely owns or manages. A client workspace keeps the entitlements it natively inherits
 * from its agency (Scale caps), so a customer working inside one is not lifted above them. Pure so it is unit-testable.
 */
export function isOperatorHomeWorkspace(ownerHomeOrgId: string | null | undefined, orgId: string | null | undefined): boolean {
  return Boolean(ownerHomeOrgId) && Boolean(orgId) && ownerHomeOrgId === orgId;
}

export interface WorkspaceAuthSources {
  /** organizations.ownerId -> users.email (null if unowned / unresolved). */
  ownerEmail?: string | null;
  /** parent-agency owner email (null if no agency / unresolved). */
  agencyOwnerEmail?: string | null;
  /** Platform-admin allowlist (e.g. parsed SF_SUPERADMIN_EMAILS). */
  adminEmails?: readonly string[] | null;
  /** EPIC 2026-10-08: emails of people the workspace owner / agency has ALREADY added to this workspace as owner or admin
   *  members (org_members). An agency-owned client workspace has exactly one ownerId (the agency), so without this the
   *  client's own person could never receive a sign-in link. */
  memberEmails?: readonly string[] | null;
}

/**
 * Pure authorization check for operator magic-link issuance.
 *
 * Returns true iff `email` (after normalization) matches the workspace
 * owner, the parent-agency owner, or a platform-admin allowlist entry.
 * Every source is normalized the same way before comparison, so case and
 * surrounding whitespace never matter. A null/empty submitted email — or
 * the absence of any matching source — yields false.
 */
export function isEmailAuthorizedForWorkspace(
  email: string | null | undefined,
  sources: WorkspaceAuthSources,
): boolean {
  const candidate = normalizeEmail(email);
  if (!candidate) return false;

  const owner = normalizeEmail(sources.ownerEmail);
  if (owner && candidate === owner) return true;

  const agencyOwner = normalizeEmail(sources.agencyOwnerEmail);
  if (agencyOwner && candidate === agencyOwner) return true;

  const admins = sources.adminEmails ?? [];
  for (const admin of admins) {
    if (normalizeEmail(admin) === candidate) return true;
  }

  for (const member of sources.memberEmails ?? []) {
    if (normalizeEmail(member) === candidate) return true;
  }

  return false;
}
