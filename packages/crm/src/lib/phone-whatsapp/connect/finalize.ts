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
//
// SUBSCRIBE (2026-10-19). After registration and before activation the app is subscribed to the customer's WABA (POST /{waba}/subscribed_apps).
// It was missing: without it no webhook for the number reaches EPIC. Idempotent at Meta; a failure leaves the connection 'registered', and the
// retry subscribes and binds without registering again.
//
// COEXISTENCE (2026-10-19, owner: the first option). When Meta reports the number as also in use in the WhatsApp Business app, there is NO
// registration and NO PIN (the number is already registered). Instead:
//   save token as PENDING -> COEX_LINKING -> subscribe app -> ensure the Chatwoot inbox -> phone override to OUR receiver
//   -> CONNECTED_COEXISTENCE (adds the link row) -> request the one-time contacts sync, then the history sync.
// Every step before the binding is idempotent, so any failure marks the connection 'failed' (nothing irreversible happened) and a fresh attempt
// repeats them. The two sync requests are ONE-TIME at Meta: each is requested at most once per connection, and its outcome (requested /
// rejected / unknown) is recorded and never retried automatically, also not with a changed request (Law 10).
import { createHash, randomBytes, randomInt } from "node:crypto";

import { verifyClaimedAssets, type ConnectMode, type GraphClient, type RefusalCode, type Verified } from "./verify-assets";

export const TERMS_VERSION = "whatsapp-connect-v2";
export const ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const MAX_LIVE_ATTEMPTS = 5;

export type Consent = { termsVersion: string; at: string; userId: string };
export type ConnectionStatus =
  | "pending"
  | "registering"
  | "registered"
  | "active"
  | "failed"
  | "coex_linking"
  | "connected_coexistence"
  | "disconnected";
export type ConnectionRecord = { status: ConnectionStatus; wabaId: string; hasPin: boolean };

export type SyncType = "smb_app_state_sync" | "history";
export type SyncOutcome = { status: "requested" | "rejected" | "unknown" | "skipped_bot_attached" | "skipped_check_failed"; at: string; requestId?: string | null };
export type CoexBinding = { chatwootAccountId: string; inboxId: number; forwardUrl: string };

export type FinalizeCode =
  | RefusalCode
  | "attempt_invalid"
  | "attempt_superseded"
  | "register_failed"
  | "subscribe_failed"
  | "coexistence_setup_failed"
  | "persist_failed"
  | "forbidden"
  | "needs_review";
export type StartResult = { ok: true; nonce: string; expiresAt: string } | { ok: false; code: "forbidden" | "persist_failed" };
export type FinalizeResult =
  | { ok: true; displayNumber: string | null; phoneNumberId: string; resumed: boolean; mode?: ConnectMode }
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
  /** Coexistence: adds the link row (source "connect", mode "coexistence"), stores the Chatwoot binding, marks connected_coexistence. */
  activateCoexistence(a: { orgId: string; wabaId: string; phoneNumberId: string; label: string | null; connectedAt: string; binding: CoexBinding }): Promise<void>;
  /** One-time sync outcomes recorded on the connection (absent key = never requested). */
  getSyncs(a: { orgId: string; phoneNumberId: string }): Promise<Partial<Record<SyncType, SyncOutcome>>>;
  recordSync(a: { orgId: string; phoneNumberId: string; syncType: SyncType; outcome: SyncOutcome }): Promise<void>;
}

/** The coexistence ports. Absent = coexistence unavailable for this workspace (verify refuses such a number, exactly as before). */
export type CoexPorts = {
  /** Find or create the Chatwoot WhatsApp inbox for the number; returns the binding the receiver forwards to. */
  ensureInbox(a: { token: string; wabaId: string; phoneNumberId: string; displayNumber: string | null; label: string | null }): Promise<CoexBinding>;
  /** Points the number's phone-level override at our receiver. */
  setOverride(token: string, phoneNumberId: string): Promise<void>;
  requestSync(token: string, phoneNumberId: string, syncType: SyncType): Promise<string | null>;
  /** True when an agent bot is attached to the number's Chatwoot inbox. inboxId null = resolve it from the stored binding. Throws when unknown. */
  inboxBotAttached(a: { orgId: string; phoneNumberId: string; inboxId: number | null }): Promise<boolean>;
};

export type FinalizeDeps = {
  store: ConnectStore;
  graph: GraphClient;
  exchangeCode(code: string): Promise<string>;
  register(token: string, phoneNumberId: string, pin: string): Promise<void>;
  /** POST /{waba}/subscribed_apps with the customer's token. */
  subscribeApp(token: string, wabaId: string): Promise<void>;
  /** True when Meta explicitly rejected the call (so nothing was registered). Timeouts / 5xx / crashes are NOT definite. */
  isDefiniteFailure(e: unknown): boolean;
  encrypt(v: string): string;
  ourAppId: string;
  epicWabaIds: ReadonlySet<string>;
  protectedPhoneIds: ReadonlySet<string>;
  now(): Date;
  coex?: CoexPorts;
  /** Audit record of a connect transition (no secrets, no message content). Must never throw into the journey. */
  audit?(orgId: string, step: string, props: Record<string, unknown>): void;
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
  coexistence_not_confirmed: "Meta does not report this number as in use in the WhatsApp Business app, so it was not connected. Nothing was registered. Choose the new-number option instead.",
  subscribe_failed: "Your number is registered with Meta, but EPIC could not subscribe to its WhatsApp account, so the connection was not finished. Connect again to finish; the number will not be registered a second time.",
  coexistence_setup_failed: "The WhatsApp Business app connection could not be completed. Your app keeps working as before and nothing was registered. You can try again.",
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

const audit = (deps: FinalizeDeps, orgId: string, step: string, props: Record<string, unknown>) => {
  try { deps.audit?.(orgId, step, props); } catch { /* audit must never break the journey */ }
};

export async function finalizeConnect(
  p: { orgId: string; userId: string; nonce: unknown; code: unknown; wabaId: unknown; phoneNumberId: unknown; flow?: unknown },
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
  const flow = p.flow === "coexistence" ? "coexistence" : "standard";
  const v = await verifyClaimedAssets(
    { token, wabaId: p.wabaId, phoneNumberId: p.phoneNumberId, orgId: p.orgId, flow },
    {
      graph: deps.graph,
      ourAppId: deps.ourAppId,
      epicWabaIds: deps.epicWabaIds,
      protectedPhoneIds: deps.protectedPhoneIds,
      claimants: (id) => deps.store.claimants(id),
      coexistenceAvailable: deps.coex !== undefined,
    },
  );
  if (!v.ok) {
    audit(deps, p.orgId, "refused", { code: v.code, flow });
    return fail(v.code);
  }

  if (v.mode === "coexistence") return completeCoexistence({ orgId: p.orgId, token, v, consent }, deps);
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
  // A number recorded under the other mode (or disconnected by the customer) is never silently switched by this path.
  if (existing && (existing.status === "coex_linking" || existing.status === "connected_coexistence" || existing.status === "disconnected")) return fail("needs_review");

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
    audit(deps, orgId, "registered", { mode: "standard", phoneNumberId: v.phoneNumberId });
  }

  // Subscribe our app to the customer's WABA (idempotent at Meta). Failure: stays 'registered'; a retry subscribes and binds, never re-registers.
  try {
    await deps.subscribeApp(p.token, v.wabaId);
  } catch {
    audit(deps, orgId, "subscribe_failed", { mode: "standard", phoneNumberId: v.phoneNumberId });
    return fail("subscribe_failed");
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
  audit(deps, orgId, "active", { mode: "standard", phoneNumberId: v.phoneNumberId, resumed });
  return { ok: true, displayNumber: v.displayNumber, phoneNumberId: v.phoneNumberId, resumed };
}

/** Requests each one-time sync that has never been requested for this connection, in Meta's documented order (contacts, then history). */
async function requestSyncsOnce(orgId: string, token: string, phoneNumberId: string, deps: FinalizeDeps, inboxId: number | null): Promise<void> {
  const coex = deps.coex!;
  let done: Partial<Record<SyncType, SyncOutcome>>;
  let syncGate: "clear" | "skipped_bot_attached" | "skipped_check_failed" = "clear";
  try {
    done = await deps.store.getSyncs({ orgId, phoneNumberId });
  } catch {
    return; // unknown state: request nothing (a sync is one-time at Meta); the page shows it as not requested yet
  }
  if (!(done.smb_app_state_sync && done.history)) {
    // BOT GUARD (2026-10-19): an agent bot attached to the inbox would receive every imported note, so the one-time sync is NOT requested
    // when a bot is attached, or when that cannot be confirmed (fail closed). The skip is recorded as the sync's one-time outcome.
    let gate: "clear" | "skipped_bot_attached" | "skipped_check_failed";
    try {
      gate = (await coex.inboxBotAttached({ orgId, phoneNumberId, inboxId })) ? "skipped_bot_attached" : "clear";
    } catch {
      gate = "skipped_check_failed";
    }
    if (gate !== "clear") audit(deps, orgId, "sync_gate", { phoneNumberId, gate });
    syncGate = gate;
  }
  for (const syncType of ["smb_app_state_sync", "history"] as const) {
    if (done[syncType]) continue; // requested, rejected or unknown before: never again, also not with a changed request
    let outcome: SyncOutcome;
    if (syncGate !== "clear") {
      outcome = { status: syncGate, at: deps.now().toISOString() }; // nothing sent to Meta
    } else try {
      const requestId = await coex.requestSync(token, phoneNumberId, syncType);
      outcome = { status: "requested", at: deps.now().toISOString(), requestId };
    } catch (e) {
      outcome = { status: deps.isDefiniteFailure(e) ? "rejected" : "unknown", at: deps.now().toISOString() };
    }
    try {
      await deps.store.recordSync({ orgId, phoneNumberId, syncType, outcome });
    } catch {
      audit(deps, orgId, "sync_record_failed", { phoneNumberId, syncType, status: outcome.status });
      return; // stop: without a record the next one must not be sent either
    }
    audit(deps, orgId, "sync", { phoneNumberId, syncType, status: outcome.status });
  }
}

async function completeCoexistence(p: { orgId: string; token: string; v: Verified; consent: Consent }, deps: FinalizeDeps): Promise<FinalizeResult> {
  const { orgId, v, token } = p;
  const coex = deps.coex;
  if (!coex) return fail("coexistence_not_supported_here"); // defensive: verify already refuses this
  const key = { orgId, phoneNumberId: v.phoneNumberId };
  let existing: ConnectionRecord | null;
  try {
    existing = await deps.store.getConnection(key);
  } catch {
    return fail("persist_failed");
  }
  const done = { ok: true as const, displayNumber: v.displayNumber, phoneNumberId: v.phoneNumberId, mode: "coexistence" as const };

  // Already connected: only the one-time syncs that were never requested are requested (nothing else repeated).
  if (existing?.status === "connected_coexistence") {
    await requestSyncsOnce(orgId, token, v.phoneNumberId, deps, null);
    return { ...done, resumed: true };
  }
  // A number on the standard path (registering/registered/active) or disconnected by the customer is never switched by this path.
  if (existing && !["pending", "failed", "coex_linking"].includes(existing.status)) return fail("needs_review");

  try {
    await deps.store.savePending({ orgId, wabaId: v.wabaId, phoneNumberId: v.phoneNumberId, tokenEnc: deps.encrypt(token), pinEnc: null, consent: p.consent, attemptId: randomBytes(12).toString("hex") });
    await deps.store.setStatus({ ...key, status: "coex_linking" });
  } catch {
    return fail("persist_failed");
  }
  audit(deps, orgId, "coex_linking", { phoneNumberId: v.phoneNumberId });

  // Idempotent steps. Any failure: 'failed' (nothing irreversible happened; the app keeps working), a fresh attempt repeats them.
  let binding: CoexBinding;
  try {
    await deps.subscribeApp(token, v.wabaId);
    binding = await coex.ensureInbox({ token, wabaId: v.wabaId, phoneNumberId: v.phoneNumberId, displayNumber: v.displayNumber, label: v.verifiedName });
    await coex.setOverride(token, v.phoneNumberId);
  } catch (e) {
    const reason = e instanceof Error ? e.name : "error";
    await deps.store.setStatus({ ...key, status: "failed", reason: `coex_setup_${reason}`.slice(0, 60) }).catch(() => undefined);
    audit(deps, orgId, "coex_setup_failed", { phoneNumberId: v.phoneNumberId, reason });
    return fail("coexistence_setup_failed");
  }

  try {
    await deps.store.activateCoexistence({ orgId, wabaId: v.wabaId, phoneNumberId: v.phoneNumberId, label: v.verifiedName, connectedAt: deps.now().toISOString(), binding });
  } catch {
    return fail("persist_failed"); // stays coex_linking: a retry repeats the idempotent steps and binds
  }
  audit(deps, orgId, "connected_coexistence", { phoneNumberId: v.phoneNumberId, chatwootInboxId: binding.inboxId });

  await requestSyncsOnce(orgId, token, v.phoneNumberId, deps, binding.inboxId);
  return { ...done, resumed: existing !== null };
}
