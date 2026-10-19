// Standard Meta connection: server-side verification of the assets a customer claims to have authorised.
//
// The browser's Embedded Signup event (phone_number_id, waba_id) is only a HINT. Nothing it says is believed until Meta, asked with the
// customer's own exchanged token, agrees. This module is PURE: it takes the facts Meta returned (via an injected GraphClient) and decides.
// Every refusal has a stable code so the UI can say something true and the tests can pin each one.
//
// COEXISTENCE (2026-10-19). A number Meta reports as also in use in the WhatsApp Business app (is_on_biz_app = true, or platform_type
// NOT_APPLICABLE_BUSINESS_APP) is accepted as mode "coexistence" ONLY when the deployment has the coexistence path configured
// (deps.coexistenceAvailable); otherwise it is refused exactly as before. The mode comes from Meta's read, never from the browser's flow
// choice: a browser that ran the coexistence flow for a number Meta does NOT report as on the Business app is refused
// (coexistence_not_confirmed), so a forged or mistaken claim can never skip registration on a Cloud API number. Every deny-list, the app and
// scope checks, the phone-on-WABA check and already_bound apply to both modes.

export type RefusalCode =
  | "platform_unverified"
  | "bad_input"
  | "token_invalid"
  | "wrong_app"
  | "missing_scope"
  | "waba_not_authorised"
  | "phone_not_on_waba"
  | "coexistence_not_supported_here"
  | "coexistence_not_confirmed"
  | "not_cloud_api"
  | "protected_asset"
  | "epic_owned_waba"
  | "already_bound"
  | "meta_unavailable";

export type ConnectMode = "standard" | "coexistence";

export type Verified = {
  ok: true;
  wabaId: string;
  phoneNumberId: string;
  displayNumber: string | null;
  verifiedName: string | null;
  platformType: string | null;
  /** Decided from Meta's read only. */
  mode: ConnectMode;
};
export type Refused = { ok: false; code: RefusalCode; message: string };
export type VerifyResult = Verified | Refused;

export type DebugToken = {
  isValid: boolean;
  appId: string | null;
  scopes: string[];
  /** WABA ids the token is scoped to (granular_scopes whatsapp_business_management / _messaging targets). */
  wabaTargets: string[];
};

export type WabaPhone = {
  id: string;
  displayNumber: string | null;
  verifiedName: string | null;
  platformType: string | null;
  /** Meta's is_on_biz_app flag when present (coexistence). */
  isOnBizApp: boolean | null;
};

export interface GraphClient {
  debugToken(token: string): Promise<DebugToken>;
  listWabaPhones(token: string, wabaId: string): Promise<WabaPhone[]>;
}

export type VerifyDeps = {
  graph: GraphClient;
  ourAppId: string;
  /** WABAs owned by EPIC itself: a customer connect can never bind them. */
  epicWabaIds: ReadonlySet<string>;
  /** Phone-number ids that are protected EPIC lines. */
  protectedPhoneIds: ReadonlySet<string>;
  /** Which workspaces already claim this phone id (from the link store). */
  claimants(phoneNumberId: string): Promise<string[]>;
  /** True only when this deployment has the coexistence path configured for the workspace. Absent = false (refused as before). */
  coexistenceAvailable?: boolean;
};

const DIGITS = /^[0-9]{5,20}$/;
const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

const refuse = (code: RefusalCode, message: string): Refused => ({ ok: false, code, message });

const onBizApp = (p: WabaPhone) => p.isOnBizApp === true || (p.platformType ?? "").toUpperCase() === "NOT_APPLICABLE_BUSINESS_APP";

export async function verifyClaimedAssets(
  input: { token: string; wabaId: unknown; phoneNumberId: unknown; orgId: string; flow?: "standard" | "coexistence" },
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const flow = input.flow === "coexistence" ? "coexistence" : "standard";
  const waba = typeof input.wabaId === "string" ? input.wabaId.trim() : "";
  let phone = typeof input.phoneNumberId === "string" ? input.phoneNumberId.trim() : "";
  // Meta's Business-app completion event may omit the phone id; only that flow may leave it empty (resolved from Meta below).
  const resolvePhone = flow === "coexistence" && phone === "";
  if (!input.token || !DIGITS.test(waba) || (!resolvePhone && !DIGITS.test(phone))) {
    return refuse("bad_input", "The connection details were incomplete.");
  }

  // Cheap local refusals first, before any call to Meta: EPIC's own assets are never customer-bindable.
  if (deps.epicWabaIds.has(waba)) return refuse("epic_owned_waba", "That WhatsApp account belongs to EPIC and cannot be connected here.");
  if (!resolvePhone && deps.protectedPhoneIds.has(phone)) return refuse("protected_asset", "That number is a protected EPIC line and cannot be connected here.");

  let dbg: DebugToken;
  try {
    dbg = await deps.graph.debugToken(input.token);
  } catch {
    return refuse("meta_unavailable", "Meta could not be reached to confirm the connection. Nothing was connected.");
  }
  if (!dbg.isValid) return refuse("token_invalid", "Meta did not accept the authorisation. Nothing was connected.");
  if (dbg.appId !== deps.ourAppId) return refuse("wrong_app", "The authorisation was not issued for this application.");
  for (const s of REQUIRED_SCOPES) {
    if (!dbg.scopes.includes(s)) return refuse("missing_scope", "The authorisation did not include the WhatsApp permissions needed.");
  }
  if (!dbg.wabaTargets.includes(waba)) return refuse("waba_not_authorised", "You did not authorise that WhatsApp account.");

  let phones: WabaPhone[];
  try {
    phones = await deps.graph.listWabaPhones(input.token, waba);
  } catch {
    return refuse("meta_unavailable", "Meta could not be reached to list the numbers. Nothing was connected.");
  }
  if (resolvePhone) {
    // Exactly one Business-app number on the authorised account, or we do not guess.
    const candidates = phones.filter(onBizApp);
    if (candidates.length !== 1) return refuse("phone_not_on_waba", "Meta did not identify exactly one WhatsApp Business app number on the account you authorised.");
    phone = candidates[0].id;
    if (!DIGITS.test(phone)) return refuse("bad_input", "The connection details were incomplete.");
    if (deps.protectedPhoneIds.has(phone)) return refuse("protected_asset", "That number is a protected EPIC line and cannot be connected here.");
  }
  const found = phones.find((p) => p.id === phone);
  if (!found) return refuse("phone_not_on_waba", "That number is not on the WhatsApp account you authorised.");

  // Coexistence is derived from Meta, never from anything the browser said.
  const platform = (found.platformType ?? "").toUpperCase();
  let mode: ConnectMode = "standard";
  if (onBizApp(found)) {
    if (!deps.coexistenceAvailable) {
      return refuse("coexistence_not_supported_here", "This number is also used in the WhatsApp Business app. That setup is handled separately.");
    }
    mode = "coexistence";
  } else {
    if (flow === "coexistence") {
      return refuse("coexistence_not_confirmed", "Meta does not report this number as in use in the WhatsApp Business app, so it was not connected. Nothing was registered.");
    }
    // Fail closed: a missing platform is not evidence of Cloud API eligibility (Codex review). Accepted: CLOUD_API, and NOT_APPLICABLE,
    // the value expected for a number that is on the WABA but not yet registered (this check runs before registration). The first live
    // connection verifies that expectation; if Meta reports something else, nothing has been registered or stored.
    if (!platform) return refuse("platform_unverified", "Meta did not report this number's platform, so it was not connected. Nothing was registered.");
    if (platform !== "CLOUD_API" && platform !== "NOT_APPLICABLE") {
      return refuse("not_cloud_api", "This number is not on the WhatsApp Cloud API.");
    }
  }

  const owners = await deps.claimants(phone);
  if (owners.some((o) => o !== input.orgId) || owners.length > 1) {
    return refuse("already_bound", "That number is already connected to a workspace.");
  }

  return {
    ok: true,
    wabaId: waba,
    phoneNumberId: phone,
    displayNumber: found.displayNumber,
    verifiedName: found.verifiedName,
    platformType: found.platformType,
    mode,
  };
}
