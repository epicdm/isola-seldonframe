// Origin the proxy uses for its own /api/v1/public/domain lookup.
//
// 2026-10-21 (Lane A) — on host04 the lookup goes to request.url, i.e. the
// PUBLIC hostname. Called from inside the container, that hairpin returns 403
// "Forbidden". The proxy then catches the JSON error and falls back to the
// hard-coded defaults (landing "home", booking "default").
//
// Switching to the internal origin makes the lookup succeed. That CHANGES live
// behaviour: /book would resolve to the workspace's most recent booking instead
// of "default". So it is gated, OFF by default. Unset, the proxy behaves
// byte-for-byte as before. Turning it on needs the owner's approval of that
// /book change.
//
//   UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP=1   enable
//   UPLINK_PROXY_INTERNAL_ORIGIN=<origin>   optional; default http://127.0.0.1:$PORT (3000)

type Env = Record<string, string | undefined>;

export function isInternalDomainLookupEnabled(env: Env = process.env): boolean {
  return env.UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP?.trim() === "1";
}

export function resolveDomainLookupOrigin(requestUrl: string, env: Env = process.env): string {
  if (!isInternalDomainLookupEnabled(env)) return requestUrl;
  const configured = env.UPLINK_PROXY_INTERNAL_ORIGIN?.trim();
  if (configured) return configured;
  return `http://127.0.0.1:${env.PORT?.trim() || "3000"}`;
}
