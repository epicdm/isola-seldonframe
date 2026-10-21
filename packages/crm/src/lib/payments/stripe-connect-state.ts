// Signed, expiring state for the Stripe Connect (Standard OAuth)
// flow — Port def-uplink-stripe-connect-callback-unsigned-state-workspace-hijack-2026-10-21.
//
// Same construction as the MCP connect flow (lib/agents/mcp/oauth-state-cookie.ts):
// the OAuth `state` query parameter is an opaque random nonce, and an
// httpOnly cookie carries `{ nonce, orgId, userId, exp }` HMAC-signed with
// AUTH_SECRET (NEXTAUTH_SECRET fallback). The callback trusts nothing from the
// query string except the nonce, and only when it equals the signed cookie's.
// The callback clears the cookie on every outcome, so a browser that follows
// the response cannot present it again. This is not a server-side nonce ledger:
// a client that keeps the cookie can present it again until it expires, but only
// from the same user's session in the same workspace (the binding is signed).
//
// Format: `${base64url(json)}.${base64url(hmacSha256(base64url(json), secret))}`,
// compared in constant time.

import crypto from "node:crypto";
import { z } from "zod";

export const STRIPE_CONNECT_STATE_COOKIE = "sf_stripe_connect";
export const STRIPE_CONNECT_STATE_MAX_AGE_SECONDS = 600; // 10 minutes

export type StripeConnectState = {
  v: 1;
  /** The value sent to Stripe as the OAuth `state` parameter. */
  nonce: string;
  orgId: string;
  userId: string;
  /** Epoch ms; rejected once now() > exp. */
  exp: number;
};

const stripeConnectStateSchema: z.ZodType<StripeConnectState> = z.object({
  v: z.literal(1),
  nonce: z.string().min(16),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  exp: z.number(),
}) as z.ZodType<StripeConnectState>;

/** The existing app signing secret (AUTH_SECRET, NEXTAUTH_SECRET fallback). Empty string when unset. */
export function resolveStripeConnectStateSecret(): string {
  return process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim() || "";
}

export function newStripeConnectNonce(): string {
  return base64url(crypto.randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(payloadB64: string, secret: string): string {
  return base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function signStripeConnectState(payload: StripeConnectState, secret: string): string {
  if (!secret) throw new Error("Stripe Connect state secret is not configured");
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${hmac(payloadB64, secret)}`;
}

export type StripeConnectStateCheck =
  | { ok: true; state: StripeConnectState }
  | { ok: false; reason: "bad_state" | "expired" };

/** Verify + decode a signed cookie value. Never throws. An empty secret verifies nothing. */
export function verifyStripeConnectState(
  cookieValue: string | undefined,
  secret: string,
  now: () => number = Date.now,
): StripeConnectStateCheck {
  if (!secret || typeof cookieValue !== "string") return { ok: false, reason: "bad_state" };
  const parts = cookieValue.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "bad_state" };
  const [payloadB64, sig] = parts;
  if (!timingSafeEqualStr(sig, hmac(payloadB64, secret))) return { ok: false, reason: "bad_state" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_state" };
  }
  const parsed = stripeConnectStateSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "bad_state" };
  if (now() > parsed.data.exp) return { ok: false, reason: "expired" };
  return { ok: true, state: parsed.data };
}

/** Constant-time compare of the callback's `state` query value against the signed nonce. */
export function stripeConnectNonceMatches(queryState: string, state: StripeConnectState): boolean {
  return timingSafeEqualStr(queryState, state.nonce);
}
