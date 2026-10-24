// Chatwoot customer link: configuration. Pure (env-like in), fail closed. Server-only values; nothing here is ever sent to a browser
// except the public base URL and the account id, which together only form a link that opens behind Chatwoot's own login.
//
// The feature is AVAILABLE for a workspace only when that workspace is mapped to exactly one Chatwoot account:
//   CHATWOOT_LINK_ACCOUNTS        "<workspace uuid>:<chatwoot account id>,..."  (no mapping = nothing is shown, no Chatwoot call is made)
//   CHATWOOT_LINK_PUBLIC_URL      the Chatwoot dashboard origin agents sign in to (https only); links are built from it
// Looking up "possible matches" additionally needs a server-side read credential:
//   CHATWOOT_LINK_API_URL         Chatwoot base URL for API calls (may be an internal http URL; default: CHATWOOT_LINK_PUBLIC_URL)
//   CHATWOOT_LINK_API_TOKEN_FILE  path to a file holding a Chatwoot user access token in that account (read at call time, never logged)
// Same mapping shape as PHONE_COEX_CHATWOOT_ACCOUNTS (coexistence-config.ts). A workspace listed twice with different accounts is ambiguous
// and gets nothing.

export type EnvLike = Record<string, string | undefined>;

/** Enough to render a confirmed link. */
export type ChatwootLinkTarget = { publicBase: string; accountId: string };
/** Enough to look up candidates (read-only GETs). */
export type ChatwootLookupConfig = ChatwootLinkTarget & { apiBase: string; apiToken: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trimBase = (v: string | undefined) => (v ?? "").trim().replace(/\/+$/, "");

/** The Chatwoot account mapped to this workspace, or null (unmapped, malformed, or ambiguous). */
export function chatwootAccountForOrg(orgId: string | null | undefined, raw: string | undefined): string | null {
  if (!orgId || !UUID.test(orgId)) return null;
  const found = new Set<string>();
  for (const pair of (raw ?? "").split(",")) {
    const [org, acct, extra] = pair.split(":").map((x) => (x ?? "").trim());
    if (extra !== undefined) continue;
    if (org && acct && UUID.test(org) && /^[1-9]\d{0,9}$/.test(acct) && org.toLowerCase() === orgId.toLowerCase()) found.add(acct);
  }
  return found.size === 1 ? [...found][0] : null;
}

function baseUrl(v: string, allowHttp: boolean): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.username || u.password || u.search || u.hash) return null; // a bare origin (+ optional path), never credentials or a query
    if (u.protocol === "https:" || (allowHttp && u.protocol === "http:")) return v;
    return null;
  } catch {
    return null;
  }
}

export function loadChatwootLinkTarget(orgId: string | null | undefined, env: EnvLike): ChatwootLinkTarget | null {
  const accountId = chatwootAccountForOrg(orgId, env.CHATWOOT_LINK_ACCOUNTS);
  const publicBase = baseUrl(trimBase(env.CHATWOOT_LINK_PUBLIC_URL), false);
  if (!accountId || !publicBase) return null;
  return { publicBase, accountId };
}

export function loadChatwootLookupConfig(
  orgId: string | null | undefined,
  env: EnvLike,
  readSecretFile: (path: string) => string,
): ChatwootLookupConfig | null {
  const target = loadChatwootLinkTarget(orgId, env);
  if (!target) return null;
  const apiBase = baseUrl(trimBase(env.CHATWOOT_LINK_API_URL) || target.publicBase, true);
  const file = (env.CHATWOOT_LINK_API_TOKEN_FILE ?? "").trim();
  if (!apiBase || !file) return null;
  let apiToken = "";
  try {
    apiToken = readSecretFile(file).trim();
  } catch {
    return null;
  }
  if (!apiToken || /\s/.test(apiToken)) return null;
  return { ...target, apiBase, apiToken };
}

/** The Chatwoot dashboard URL of a conversation. `displayId` is the conversation number Chatwoot shows (its API "id"). No token, ever. */
export function chatwootConversationUrl(target: ChatwootLinkTarget, displayId: number): string {
  if (!Number.isInteger(displayId) || displayId <= 0) throw new Error("invalid conversation id");
  return `${target.publicBase}/app/accounts/${encodeURIComponent(target.accountId)}/conversations/${displayId}`;
}
