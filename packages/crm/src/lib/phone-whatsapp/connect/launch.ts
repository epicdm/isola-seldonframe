// Embedded Signup launch options and session-info parsing for the browser panel (pure, so they are testable).
// Meta's current (v4) implementation: the FLfB configuration selects the products and therefore the flow version; the launch `extras` carries
// only `setup: {}` (v2's `sessionInfoVersion`/`featureType` are not part of it; v2/v3 were retired on 2026-10-15). The standard Cloud API
// completion event is FINISH; FINISH_ONLY_WABA (no number), FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (coexistence, excluded) and the other
// finish types are deliberately NOT accepted here, and the server re-verifies everything with Meta regardless.

export function embeddedSignupLoginOptions(configId: string) {
  return { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } } as const;
}

/** Hints from Meta's session-info message, or null when the message is not a standard Cloud API completion from Facebook. */
export function hintsFromSessionMessage(origin: string, raw: unknown): { wabaId: string; phoneNumberId: string } | null {
  let host = "";
  try { host = new URL(origin).hostname; } catch { return null; }
  if (!/(^|\.)facebook\.com$/.test(host)) return null;
  let d: { type?: unknown; event?: unknown; data?: { waba_id?: unknown; phone_number_id?: unknown } } | null;
  try { d = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof d); } catch { return null; }
  if (d?.type !== "WA_EMBEDDED_SIGNUP" || d.event !== "FINISH" || !d.data) return null;
  return { wabaId: String(d.data.waba_id ?? ""), phoneNumberId: String(d.data.phone_number_id ?? "") };
}
