// Embedded Signup launch options and session-info parsing for the browser panel (pure, so they are testable).
// Meta's current (v4) implementation: the FLfB configuration selects the products and therefore the flow version; the launch `extras` carries
// only `setup: {}` for the standard Cloud API flow (v2's `sessionInfoVersion`/`featureType` are not part of it; v2/v3 were retired on 2026-10-15).
// The standard Cloud API completion event is FINISH.
//
// COEXISTENCE (WhatsApp Business app + Cloud API on the same number, 2026-10-19, owner decision: the first option). Meta's v4 page says
// Business-app onboarding "continues to be supported through the feature_type parameter"; the only documented launch shape is the Business-app
// onboarding page's `extras: { featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }` with completion event
// FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (data.waba_id; the phone id may be absent). UNVERIFIED against a live v4 configuration: the first live
// connection checks it. Whatever the browser reports, the server re-verifies everything with Meta, and coexistence is decided ONLY from Meta's
// own is_on_biz_app / platform_type read, never from this flow choice.

export type LaunchFlow = "standard" | "coexistence";

export function embeddedSignupLoginOptions(configId: string, flow: LaunchFlow = "standard") {
  if (flow === "coexistence") {
    return {
      config_id: configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
    } as const;
  }
  return { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } } as const;
}

/**
 * Hints from Meta's session-info message, or null when the message is not a completion from Facebook for the given flow.
 * standard:    FINISH only (unchanged).
 * coexistence: FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (phone id may be empty: the server resolves it from Meta), or FINISH when the
 *              customer added a number that is not on the Business app (the server then refuses: coexistence is not confirmed by Meta).
 */
export function hintsFromSessionMessage(
  origin: string,
  raw: unknown,
  flow: LaunchFlow = "standard",
): { wabaId: string; phoneNumberId: string } | null {
  let host = "";
  try { host = new URL(origin).hostname; } catch { return null; }
  if (!/(^|\.)facebook\.com$/.test(host)) return null;
  let d: { type?: unknown; event?: unknown; data?: { waba_id?: unknown; phone_number_id?: unknown } } | null;
  try { d = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof d); } catch { return null; }
  if (d?.type !== "WA_EMBEDDED_SIGNUP" || !d.data) return null;
  const accepted = flow === "coexistence" ? ["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH"] : ["FINISH"];
  if (typeof d.event !== "string" || !accepted.includes(d.event)) return null;
  if (flow === "standard") return { wabaId: String(d.data.waba_id ?? ""), phoneNumberId: String(d.data.phone_number_id ?? "") }; // unchanged
  const wabaId = String(d.data.waba_id ?? "");
  if (!wabaId) return null;
  return { wabaId, phoneNumberId: String(d.data.phone_number_id ?? "") };
}
