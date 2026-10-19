import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
// Domain separation: the HMAC key is derived from the platform secret with a purpose label, so a signature made here can never be
// confused with another use of the same secret (Auth.js sessions, OAuth state, ...), and this module never signs with the raw secret.
const KEY_PURPOSE = "uplink/public-conversation-capability/v1";
function signingKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(KEY_PURPOSE).digest();
}
export const PUBLIC_CONVERSATION_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type PublicConversationScope = {
  conversationId: string;
  organizationId: string;
  agentId: string;
  anonymousSessionId: string;
};

type CapabilityClaims = PublicConversationScope & {
  issuedAt: number;
  expiresAt: number;
};

export function resolvePublicConversationSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim() || null;
}

export function isValidAnonymousSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isValidPublicConversationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function issuePublicConversationCapability(
  scope: PublicConversationScope,
  secret: string,
  nowMs = Date.now(),
): string {
  if (!secret) throw new Error("conversation_signing_secret_unavailable");
  const issuedAt = Math.floor(nowMs / 1000);
  const claims: CapabilityClaims = {
    ...scope,
    issuedAt,
    expiresAt: issuedAt + PUBLIC_CONVERSATION_CAPABILITY_TTL_SECONDS,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${VERSION}.${encodedClaims}`;
  const signature = createHmac("sha256", signingKey(secret)).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function isPublicConversationCapabilityValid(
  token: unknown,
  scope: PublicConversationScope,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (typeof token !== "string" || token.length > 2048 || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return false;

  const [, encodedClaims, encodedSignature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedClaims) || !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)) {
    return false;
  }

  let claims: CapabilityClaims;
  try {
    const rawClaims = Buffer.from(encodedClaims, "base64url");
    if (rawClaims.toString("base64url") !== encodedClaims) return false;
    const parsed: unknown = JSON.parse(rawClaims.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    claims = parsed as CapabilityClaims;
  } catch {
    return false;
  }

  const now = Math.floor(nowMs / 1000);
  if (
    claims.conversationId !== scope.conversationId ||
    claims.organizationId !== scope.organizationId ||
    claims.agentId !== scope.agentId ||
    claims.anonymousSessionId !== scope.anonymousSessionId ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt > now + 60 ||
    claims.expiresAt <= now ||
    claims.expiresAt - claims.issuedAt !== PUBLIC_CONVERSATION_CAPABILITY_TTL_SECONDS
  ) {
    return false;
  }

  const signingInput = `${VERSION}.${encodedClaims}`;
  const expected = createHmac("sha256", signingKey(secret)).update(signingInput).digest();
  const supplied = Buffer.from(encodedSignature, "base64url");
  return (
    supplied.length === expected.length &&
    supplied.toString("base64url") === encodedSignature &&
    timingSafeEqual(supplied, expected)
  );
}

export function authorizePublicConversationContinuation(input: {
  row: Omit<PublicConversationScope, "anonymousSessionId"> & { anonymousSessionId: string | null } | null;
  request: PublicConversationScope;
  capability: unknown;
  secret: string | null;
  nowMs?: number;
}): boolean {
  const { row, request, capability, secret, nowMs } = input;
  if (!row || !secret || !isValidAnonymousSessionId(request.anonymousSessionId)) return false;
  if (
    row.conversationId !== request.conversationId ||
    row.organizationId !== request.organizationId ||
    row.agentId !== request.agentId ||
    !row.anonymousSessionId ||
    row.anonymousSessionId !== request.anonymousSessionId
  ) {
    return false;
  }
  return isPublicConversationCapabilityValid(capability, request, secret, nowMs);
}
