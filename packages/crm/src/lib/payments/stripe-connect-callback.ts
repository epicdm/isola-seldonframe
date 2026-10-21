// Stripe Connect OAuth callback decision ladder (DI'd, pure over injected deps) — the
// logic behind app/api/stripe/connect/callback/route.ts. Port
// def-uplink-stripe-connect-callback-unsigned-state-workspace-hijack-2026-10-21.
//
// The workspace a Stripe account is bound to comes ONLY from the signed state
// cookie minted by startStripeConnectAction, never from the query string. Every
// refusal happens BEFORE the Stripe token exchange and before any write:
//   missing params | missing/forged/tampered cookie | expired | nonce mismatch |
//   no session | session user or org differs from the one that started the flow.

import {
  STRIPE_CONNECT_STATE_COOKIE,
  stripeConnectNonceMatches,
  verifyStripeConnectState,
} from "./stripe-connect-state";

export type StripeConnectTokenPayload = {
  stripe_user_id: string;
  access_token?: string | null;
  stripe_publishable_key?: string | null;
};

export type StripeConnectCallbackDeps = {
  getCookie: (name: string) => string | undefined;
  /** The signed-in user and active workspace, resolved the same way startStripeConnectAction resolves them. */
  resolveSession: () => Promise<{ userId: string; orgId: string } | null>;
  exchange: (code: string) => Promise<StripeConnectTokenPayload>;
  saveConnection: (input: { orgId: string; payload: StripeConnectTokenPayload }) => Promise<void>;
  authSecret: string;
  now?: () => number;
};

export type StripeConnectCallbackResult = {
  outcome: "connected" | "missing_params" | "bad_state" | "expired" | "session_mismatch" | "exchange_failed";
  redirect: string;
  /** Always true: the state cookie is consumed by every callback, success or refusal. */
  clearCookie: true;
};

const CONNECTED = "/settings/payments?connected=1";
const MISSING = "/settings/payments?error=connect_callback";
const FAILED = "/settings/payments?error=connect_failed";

function done(outcome: StripeConnectCallbackResult["outcome"], redirect: string): StripeConnectCallbackResult {
  return { outcome, redirect, clearCookie: true };
}

export async function handleStripeConnectCallback(
  params: { code: string | null; state: string | null },
  deps: StripeConnectCallbackDeps,
): Promise<StripeConnectCallbackResult> {
  if (!params.code || !params.state) return done("missing_params", MISSING);

  const check = verifyStripeConnectState(deps.getCookie(STRIPE_CONNECT_STATE_COOKIE), deps.authSecret, deps.now);
  if (!check.ok) return done(check.reason, FAILED);
  const signed = check.state;
  if (!stripeConnectNonceMatches(params.state, signed)) return done("bad_state", FAILED);

  const session = await deps.resolveSession().catch(() => null);
  if (!session || session.userId !== signed.userId || session.orgId !== signed.orgId) {
    return done("session_mismatch", FAILED);
  }

  try {
    const payload = await deps.exchange(params.code);
    await deps.saveConnection({ orgId: signed.orgId, payload });
  } catch {
    return done("exchange_failed", FAILED);
  }
  return done("connected", CONNECTED);
}
