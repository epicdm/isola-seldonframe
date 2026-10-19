// Coexistence (WhatsApp Business app + Cloud API on one number) configuration. Pure (env-like in), fail closed.
//
// The single message processor for a coexistence number is Chatwoot (owner decision 2026-10-19, Law 1). Meta delivers the number's
// override-eligible webhook fields to OUR receiver (PHONE_COEX_RECEIVER_URL), which forwards messages/echoes/calls byte-identical to the bound
// Chatwoot inbox and digests only history + contacts (Chatwoot has no handler for them). account_update never follows an override: it reaches
// the BFF app callback and is forwarded, signed, to /api/phone-whatsapp/connect/account-events.
//
// Coexistence is AVAILABLE for a workspace only when every value below is present AND the workspace is mapped to a Chatwoot account:
//   PHONE_COEX_RECEIVER_URL            absolute https URL Meta calls (the phone override target)
//   PHONE_COEX_RECEIVER_VERIFY_TOKEN   verify token for Meta's GET challenge on that URL (>= 16 chars)
//   PHONE_COEX_CHATWOOT_API_BASE       Chatwoot base URL for API calls (may be an internal URL)
//   PHONE_COEX_CHATWOOT_WEBHOOK_BASE   Chatwoot base URL the receiver forwards to (default: the API base)
//   PHONE_COEX_CHATWOOT_API_TOKEN      a Chatwoot access token with admin rights in the mapped account(s)
//   PHONE_COEX_CHATWOOT_ACCOUNTS       "<workspace uuid>:<chatwoot account id>,..."  (no mapping = coexistence refused for that workspace)
// Missing anything = the coexistence number is refused exactly as before this change ("coexistence_not_supported_here").
import type { EnvLike } from "./config";

export type CoexConfig = {
  receiverUrl: string;
  verifyToken: string;
  chatwootApiBase: string;
  chatwootWebhookBase: string;
  chatwootApiToken: string;
  chatwootAccountId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trimBase = (v: string | undefined) => (v ?? "").trim().replace(/\/+$/, "");

function accountFor(orgId: string, raw: string | undefined): string | null {
  for (const pair of (raw ?? "").split(",")) {
    const [org, acct] = pair.split(":").map((x) => (x ?? "").trim());
    if (org && acct && UUID.test(org) && /^\d{1,10}$/.test(acct) && org.toLowerCase() === orgId.toLowerCase()) return acct;
  }
  return null;
}

/** Returns null (coexistence unavailable) unless everything is configured for this workspace. testMode allows http:// URLs (local sinks). */
export function loadCoexConfig(orgId: string | null | undefined, env: EnvLike, testMode = false): CoexConfig | null {
  if (!orgId) return null;
  const receiverUrl = (env.PHONE_COEX_RECEIVER_URL ?? "").trim();
  const verifyToken = (env.PHONE_COEX_RECEIVER_VERIFY_TOKEN ?? "").trim();
  const chatwootApiBase = trimBase(env.PHONE_COEX_CHATWOOT_API_BASE);
  const chatwootWebhookBase = trimBase(env.PHONE_COEX_CHATWOOT_WEBHOOK_BASE) || chatwootApiBase;
  const chatwootApiToken = (env.PHONE_COEX_CHATWOOT_API_TOKEN ?? "").trim();
  const chatwootAccountId = accountFor(orgId, env.PHONE_COEX_CHATWOOT_ACCOUNTS);
  const url = (u: string) => {
    try { const p = new URL(u); return p.protocol === "https:" || (testMode && p.protocol === "http:"); } catch { return false; }
  };
  if (!url(receiverUrl) || verifyToken.length < 16 || !url(chatwootApiBase) || !url(chatwootWebhookBase) || !chatwootApiToken || !chatwootAccountId) return null;
  return { receiverUrl, verifyToken, chatwootApiBase, chatwootWebhookBase, chatwootApiToken, chatwootAccountId };
}

/** The Chatwoot inbox webhook URL for a number (Chatwoot's own route: /webhooks/whatsapp/:phone_number, phone in +E164). */
export function chatwootInboxWebhookUrl(base: string, phoneE164: string): string {
  return `${base.replace(/\/+$/, "")}/webhooks/whatsapp/${encodeURIComponent(phoneE164)}`;
}
