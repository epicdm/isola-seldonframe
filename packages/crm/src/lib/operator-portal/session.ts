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
  /** Audit row that authorizes an audited support session. */
  supportSessionId?: string | null;
  /** EPIC 2026-10-20: issue time (ms). Set on every newly minted token; tokens minted before this field existed derive it from
   *  `exp` minus their kind's TTL (see operatorTokenIssuedAt). */
  iat?: number;
};

/** A support-context session is for a human operator; never lend it to an agent run. */
export function isSupportSessionContext(user: { supportOriginUserId?: string | null } | null | undefined): boolean {
  return Boolean(user?.supportOriginUserId);
}

// EPIC 2026-10-20 — per-workspace operator-session cut-off (Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20).
// The tokens are stateless, so revocation is a server-side comparison on every read: a token issued at or before the workspace's
// organizations.operator_sessions_valid_after is refused. The TTLs below are the ones each mint path uses; they let a token minted
// before `iat` existed be dated exactly (exp = issue time + TTL), so existing cookies are covered without a payload change.
export const OPERATOR_MAGIC_LINK_TTL_MS = 15 * 60_000;
export const OPERATOR_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const OPERATOR_SUPPORT_SESSION_TTL_MS = 2 * 60 * 60_000;
/** A token dated further than this into the future (clock skew or tampering upstream of the signer) is refused outright. */
export const OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS = 60_000;

/** The token's issue time in ms: `iat` when present, else exp minus the TTL of its kind (support sessions carry supportOriginUserId). */
export function operatorTokenIssuedAt(payload: Pick<OperatorTokenPayload, "exp" | "kind" | "supportOriginUserId" | "iat">): number {
  if (typeof payload.iat === "number" && Number.isFinite(payload.iat)) return payload.iat;
  const ttl = payload.kind === "magic"
    ? OPERATOR_MAGIC_LINK_TTL_MS
    : payload.supportOriginUserId ? OPERATOR_SUPPORT_SESSION_TTL_MS : OPERATOR_SESSION_TTL_MS;
  return payload.exp - ttl;
}

/**
 * Rule: a token is revoked when its issue time is AT OR BEFORE the workspace cut-off (issuedAt <= validAfter). Equal counts as revoked,
 * so a token minted in the same millisecond as the cut-off never survives it. The cut-off is written with the same application clock
 * that stamps `iat`; a token dated more than OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS ahead of `now` is refused as untrustworthy. With no
 * cut-off (null) nothing is revoked.
 */
export function isOperatorTokenRevoked(
  payload: Pick<OperatorTokenPayload, "exp" | "kind" | "supportOriginUserId" | "iat">,
  validAfter: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  const issuedAt = operatorTokenIssuedAt(payload);
  if (!Number.isFinite(issuedAt)) return true;
  if (issuedAt > now + OPERATOR_TOKEN_MAX_FUTURE_SKEW_MS) return true;
  if (validAfter === null || validAfter === undefined) return false;
  const cutoff = validAfter instanceof Date ? validAfter.getTime() : new Date(validAfter).getTime();
  if (!Number.isFinite(cutoff)) return true;
  return issuedAt <= cutoff;
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
