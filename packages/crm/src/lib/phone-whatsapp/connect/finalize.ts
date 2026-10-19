// Standard Meta connection: the start/finalize orchestration. Pure orchestration over injected ports, so the whole journey is testable
// without Meta, a database or a session. Server-only wiring lives in ./server-wiring.ts.
//
// Order is deliberate and mirrors the deployed Embedded Signup finalize: nothing is ACTIVE unless every Meta step succeeded.
//   consume single-use nonce (bound to org + user)  ->  exchange code  ->  verify assets with Meta  ->  save secrets as PENDING
//   ->  mark REGISTERING  ->  register number (Cloud API PIN)  ->  mark REGISTERED  ->  ACTIVATE (adds the link row the panel reads).
//
// PARTIAL COMPLETION. Registration is the one step that changes the customer's number at Meta and cannot be blindly repeated or undone
// by us. The connection therefore records how far it got, and a retry resumes from there:
//   active      -> nothing to do (idempotent success)
//   registered  -> registration is NOT repeated; only the local binding is finished
//   registering -> outcome unknown (timeout / crash): needs_review. Never inferred, never repeated automatically; EPIC checks at Meta.
//   failed      -> Meta explicitly rejected the registration (4xx), so nothing was registered; a fresh attempt may register again
// Nothing here ever deregisters a number.
import { createHash, randomBytes, randomInt } from "node:crypto";

import { verifyClaimedAssets, type GraphClient, type RefusalCode, type Verified } from "./verify-assets";

export const TERMS_VERSION = "whatsapp-connect-v2";
export const ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const MAX_LIVE_ATTEMPTS = 5;

export type Consent = { termsVersion: string; at: string; userId: string };
export type ConnectionStatus = "pending" | "registering" | "registered" | "active" | "failed";
export type ConnectionRecord = { status: ConnectionStatus; wabaId: string; hasPin: boolean };

export type FinalizeCode = RefusalCode | "attempt_invalid" | "attempt_superseded" | "register_failed" | "persist_failed" | "forbidden" | "needs_review";
export type StartResult = { ok: true; nonce: string; expiresAt: string } | { ok: false; code: "forbidden" | "persist_failed" };
export type FinalizeResult =
  | { ok: true; displayNumber: string | null; phoneNumberId: string; resumed: boolean }
  | { ok: false; code: FinalizeCode; message: string };

export interface ConnectStore {
  /** Stores a hashed single-use nonce with the consent record. Expired attempts are pruned and the live set is capped; connections are never touched. */
  putAttempt(a: { orgId: string; userId: string; nonceHash: string; expiresAt: Date; now: Date; consent: Consent }): Promise<void>;
  /** Atomically consumes the attempt: the consent record only once, only for the same org+user, only before expiry; else null. */
  consumeAttempt(a: { orgId: string; userId: string; nonceHash: string; now: Date }): Promise<Consent | null>;
  /** Workspaces that already hold this number: linked lines AND unfinished (non-failed) connections. */
  claimants(phoneNumberId: string): Promise<string[]>;
  getConnection(a: { orgId: string; phoneNumberId: string }): Promise<ConnectionRecord | null>;
  /** Saves the encrypted token (always) and PIN (only when pinEnc is given) with the consent record; status becomes pending. Never lowers registered/active. */
  savePending(a: { orgId: string; wabaId: string; phoneNumberId: string; tokenEnc: string; pinEnc: string | null; consent: Consent; attemptId: string }): Promise<void>;
  /** Compare-and-set 'pending' -> 'registering', only for the attempt whose savePending is still the current one. False = another attempt took over. */
  claimRegistering(a: { orgId: string; phoneNumberId: string; attemptId: string }): Promise<boolean>;
  setStatus(a: { orgId: string; phoneNumberId: string; status: ConnectionStatus; reason?: string }): Promise<void>;
  /** Adds the link row (source "connect") and marks the connection active. */
  activate(a: { orgId: string; wabaId: string; phoneNumberId: string; label: string | null; connectedAt: string }): Promise<void>;
}

export type FinalizeDeps = {
  store: ConnectStore;
  graph: GraphClient;
  exchangeCode(code: string): Promise<string>;
  register(token: string, phoneNumberId: string, pin: string): Promise<void>;
  /** True when Meta explicitly rejected the call (so nothing was registered). Timeouts / 5xx / crashes are NOT definite. */
  isDefiniteFailure(e: unknown): boolean;
  encrypt(v: string): string;
  ourAppId: string;
  epicWabaIds: ReadonlySet<string>;
  protectedPhoneIds: ReadonlySet<string>;
  now(): Date;
};

export const hashNonce = (n: string) => createHash("sha256").update(n).digest("hex");

const MESSAGES: Record<FinalizeCode, string> = {
  bad_input: "The connection details were incomplete.",
  token_invalid: "Meta did not accept the authorisation. Nothing was connected.",
  wrong_app: "The authorisation was not issued for this application.",
  missing_scope: "The authorisation did not include the WhatsApp permissions needed.",
  waba_not_authorised: "You did not authorise that WhatsApp account.",
  phone_not_on_waba: "That number is not on the WhatsApp account you authorised.",
  coexistence_not_supported_here: "This number is also used in the WhatsApp Business app. Using the app and this connection on the same number (Coexistence) is not part of this connection.",
  not_cloud_api: "This number is not on the WhatsApp Cloud API.",
  protected_asset: "That number is a protected EPIC line and cannot be connected here.",
  epic_owned_waba: "That WhatsApp account belongs to EPIC and cannot be connected here.",
  already_bound: "That number is already connected to a workspace.",
  meta_unavailable: "Meta could not be reached. Nothing was connected.",
  attempt_invalid: "This connection attempt expired or was already used. Start again.",
  attempt_superseded: "Another connection attempt for this number replaced this one. This attempt registered nothing. Reload to see the current state.",
  platform_unverified: "Meta did not report this number's platform, so it was not connected. Nothing was registered.",
  register_failed: "Meta did not accept the number registration. Nothing was registered and nothing was connected. You can try again.",
  persist_failed: "The connection could not be saved here. If Meta already registered your number, it has not been undone: reconnect to finish, and nothing will be registered twice.",
  forbidden: "Only a workspace owner or admin can connect a number.",
  needs_review: "Meta has not confirmed whether the number registration finished. Nothing was repeated and nothing was undone. EPIC will check before anything else happens.",
};
const fail = (code: FinalizeCode): FinalizeResult => ({ ok: false, code, message: MESSAGES[code] });

/** Caller (the route) has already established: session, workspace id, role owner/admin, feature enabled. */
export async function startConnect(
  p: { orgId: string; userId: string; consentAccepted: boolean },
  deps: Pick<FinalizeDeps, "store" | "now">,
): Promise<StartResult> {
  if (!p.consentAccepted) return { ok: false, code: "forbidden" };
  const nonce = randomBytes(24).toString("base64url");
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
  try {
    await deps.store.putAttempt({
      orgId: p.orgId,
      userId: p.userId,
      nonceHash: hashNonce(nonce),
      expiresAt,
      now,
      consent: { termsVersion: TERMS_VERSION, at: now.toISOString(), userId: p.userId },
    });
  } catch {
    return { ok: false, code: "persist_failed" };
  }
  return { ok: true, nonce, expiresAt: expiresAt.toISOString() };
}

export async function finalizeConnect(
  p: { orgId: string; userId: string; nonce: unknown; code: unknown; wabaId: unknown; phoneNumberId: unknown },
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  if (typeof p.nonce !== "string" || typeof p.code !== "string" || !p.nonce || !p.code) return fail("bad_input");

  // 1. single-use nonce: spent BEFORE any Meta call, so a replay cannot reach Meta or the store.
  const consent = await deps.store.consumeAttempt({ orgId: p.orgId, userId: p.userId, nonceHash: hashNonce(p.nonce), now: deps.now() });
  if (!consent) return fail("attempt_invalid");

  // 2. exchange the one-time code server-to-server. The token never leaves this function except encrypted.
  let token: string;
  try {
    token = await deps.exchangeCode(p.code);
  } catch {
    return fail("token_invalid");
  }

  // 3. Meta must agree with every claim the browser made.
  const v = await verifyClaimedAssets(
    { token, wabaId: p.wabaId, phoneNumberId: p.phoneNumberId, orgId: p.orgId },
    {
      graph: deps.graph,
      ourAppId: deps.ourAppId,
      epicWabaIds: deps.epicWabaIds,
      protectedPhoneIds: deps.protectedPhoneIds,
      claimants: (id) => deps.store.claimants(id),
    },
  );
  if (!v.ok) return fail(v.code);

  return completeConnection({ orgId: p.orgId, token, v, consent }, deps);
}

async function completeConnection(p: { orgId: string; token: string; v: Verified; consent: Consent }, deps: FinalizeDeps): Promise<FinalizeResult> {
  const { orgId, v } = p;
  const key = { orgId, phoneNumberId: v.phoneNumberId };
  let existing: ConnectionRecord | null;
  try {
    existing = await deps.store.getConnection(key);
  } catch {
    return fail("persist_failed");
  }

  // Already finished: success, nothing repeated.
  if (existing?.status === "active") return { ok: true, displayNumber: v.displayNumber, phoneNumberId: v.phoneNumberId, resumed: true };

  const resumed = existing !== null && existing.status !== "failed" && existing.status !== "pending";
  const registered = existing?.status === "registered";

  // Unknown outcome of an earlier registration: we do NOT infer it from Meta's status (not verified against real Meta) and do NOT repeat it.
  if (existing?.status === "registering") return fail("needs_review");

  // Save (or refresh) the encrypted token. A PIN is minted only when there is none worth keeping (first time, or after a definite failure).
  // 'pending' means registration was never started (the registering mark is written BEFORE the call), so a fresh PIN is safe there too.
  const mintPin = existing === null || existing.status === "failed" || existing.status === "pending" || !existing.hasPin;
  const pin = mintPin ? String(randomInt(0, 1_000_000)).padStart(6, "0") : null;
  // Each attempt tags its save; only the attempt whose save is current may start registration (two tabs cannot both register, and the
  // PIN that Meta receives is always the PIN that is stored).
  const attemptId = randomBytes(12).toString("hex");
  try {
    await deps.store.savePending({
      orgId,
      wabaId: v.wabaId,
      phoneNumberId: v.phoneNumberId,
      tokenEnc: deps.encrypt(p.token),
      pinEnc: pin === null ? null : deps.encrypt(pin),
      consent: p.consent,
      attemptId,
    });
  } catch {
    return fail("persist_failed");
  }

  if (!registered) {
    if (pin === null) return fail("needs_review"); // defensive: no PIN to register with and no proof of registration: never guess
    let claimed: boolean;
    try {
      claimed = await deps.store.claimRegistering({ ...key, attemptId });
    } catch {
      return fail("persist_failed"); // nothing was sent to Meta yet
    }
    if (!claimed) return fail("attempt_superseded"); // another attempt saved after this one: it, not this one, may register
    try {
      await deps.register(p.token, v.phoneNumberId, pin);
    } catch (e) {
      if (deps.isDefiniteFailure(e)) {
        await deps.store.setStatus({ ...key, status: "failed", reason: "register_rejected" }).catch(() => undefined);
        return fail("register_failed");
      }
      return fail("needs_review"); // stays 'registering': outcome unknown, so no automatic repeat
    }
    try {
      await deps.store.setStatus({ ...key, status: "registered" });
    } catch {
      return fail("persist_failed"); // registered at Meta, state not recorded: stays 'registering'; the Meta status check resolves it on retry
    }
  }

  try {
    await deps.store.activate({
      orgId,
      wabaId: v.wabaId,
      phoneNumberId: v.phoneNumberId,
      label: v.verifiedName,
      connectedAt: deps.now().toISOString(),
    });
  } catch {
    return fail("persist_failed"); // stays 'registered': a retry finishes the binding without registering again
  }
  return { ok: true, displayNumber: v.displayNumber, phoneNumberId: v.phoneNumberId, resumed };
}
