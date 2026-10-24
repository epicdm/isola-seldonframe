// ============================================================================
// v1.20.0 — operator-portal session primitives
// ============================================================================
//
// Mirrors lib/portal/session.ts but for the SUB-TENANT OPERATOR audience
// (the HVAC business owner running their workspace, the agency support
// session impersonating that operator), NOT the customer audience
// (homeowner of the HVAC business).
//
// Two distinct token types issued from the same HMAC primitive:
//   - magic-link token: short TTL (15 min), one-shot, carries
//     { orgId, email, exp, kind: "magic" }
//   - session token:    long TTL (7 days), refreshable, carries
//     { orgId, email, exp, kind: "session" }
//
// We collapse both into one signed shape so the same verify path can
// cover both with a `kind` discriminator. Magic-link verification
// flips its kind="magic" payload into a kind="session" cookie on
// successful claim.

import crypto from "node:crypto";

export const OPERATOR_SESSION_COOKIE = "sf_operator_session";

export type OperatorTokenKind = "magic" | "session";

export type OperatorTokenPayload = {
  orgId: string;
  email: string;
  exp: number;
  kind: OperatorTokenKind;
  /** v1.21 hook: agency support session origin user id. NULL on
   *  normal operator-direct sessions. */
  supportOriginUserId?: string | null;
  /** Exact agency_support_sessions row closed by an explicit support exit. */
  supportSessionId?: string | null;
  /** Issued-at milliseconds, used with a workspace cutoff after ownership transfer. */
  iat?: number;
};

/** Support impersonation is for a human operator; browser support context is not agent authority.
 * Older agency support tokens predate supportSessionId, so the audited origin operator alone
 * is the authoritative signal that this is an impersonated browser context. */
export function isSupportSessionContext(value: { supportOriginUserId?: string | null; supportSessionId?: string | null } | null | undefined): boolean {
  return Boolean(value?.supportOriginUserId);
}

const MAGIC_LINK_TTL_MS = 15 * 60_000;
const OWNER_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const SUPPORT_SESSION_TTL_MS = 2 * 60 * 60_000;

export function isOperatorTokenRevoked(payload: OperatorTokenPayload, validAfter: Date | string | null | undefined, now = Date.now()): boolean {
  const ttl = payload.kind === "magic" ? MAGIC_LINK_TTL_MS : payload.supportOriginUserId ? SUPPORT_SESSION_TTL_MS : OWNER_SESSION_TTL_MS;
  const issuedAt = typeof payload.iat === "number" && Number.isFinite(payload.iat) ? payload.iat : payload.exp - ttl;
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000) return true;
  if (validAfter === null || validAfter === undefined) return false;
  const cutoff = validAfter instanceof Date ? validAfter.getTime() : new Date(validAfter).getTime();
  return !Number.isFinite(cutoff) || issuedAt <= cutoff;
}

function getOperatorSecret(): string {
  return (
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    "dev-operator-portal-secret"
  );
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

export function signOperatorToken(payload: OperatorTokenPayload): string {
  const body = toBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", getOperatorSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function verifyOperatorToken(
  token: string | null | undefined,
): OperatorTokenPayload | null {
  if (!token) return null;

  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = crypto
    .createHmac("sha256", getOperatorSecret())
    .update(body)
    .digest("base64url");
  if (signature !== expected) return null;

  let parsed: OperatorTokenPayload;
  try {
    parsed = JSON.parse(fromBase64Url(body)) as OperatorTokenPayload;
  } catch {
    return null;
  }

  if (
    !parsed?.orgId ||
    !parsed?.email ||
    typeof parsed.exp !== "number" ||
    (parsed.kind !== "magic" && parsed.kind !== "session")
  ) {
    return null;
  }

  if (Date.now() > parsed.exp) return null;

  return parsed;
}
