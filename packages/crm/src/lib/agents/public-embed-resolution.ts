export type PublicEmbedAgent = {
  orgSlug: string;
  slug: string;
  status: string;
};

export function resolveRequestedEmbedAgent<T extends PublicEmbedAgent>(
  rows: readonly T[],
  orgSlug: string,
  agentSlug: string,
): T | null {
  return rows.find((row) => row.orgSlug === orgSlug && row.slug === agentSlug) ?? null;
}

export function isEmbedAgentAccessible(status: string): boolean {
  return status === "live" || status === "test";
}

export function buildEmbedTurnUrl(origin: string, orgSlug: string, agentSlug: string): string {
  return `${origin}/api/v1/public/agent/${orgSlug}--${agentSlug}/turn`;
}

/**
 * The origin the chat widget must POST to.
 *
 * `request.url` inside the container is the server's internal bind address
 * (`https://0.0.0.0:3000`), which put an unreachable URL into the script and made
 * every visitor message fail. The public host is the Host / X-Forwarded-Host the
 * proxy passes through. It is only trusted when it is one of this platform's own
 * hosts (the app host, the workspace base domain, or a workspace subdomain), so a
 * spoofed Host header cannot point visitors' messages at another origin. Anything
 * else falls back to the canonical app origin.
 */
export function resolveEmbedOrigin(input: {
  host: string | null | undefined;
  forwardedHost: string | null | undefined;
  forwardedProto: string | null | undefined;
  appUrl: string;
  workspaceBaseDomain: string;
}): string {
  const canonical = input.appUrl.replace(/\/+$/, "");
  let appHost = "";
  try {
    appHost = new URL(canonical).host.toLowerCase();
  } catch {
    return canonical;
  }
  const base = input.workspaceBaseDomain.trim().toLowerCase();
  const candidate = (input.forwardedHost?.split(",")[0] ?? input.host ?? "").trim().toLowerCase();
  const isHostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(candidate);
  const trusted =
    isHostname &&
    (candidate === appHost || (base !== "" && (candidate === base || candidate.endsWith(`.${base}`))));
  if (!trusted) return canonical;
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return `${proto === "http" ? "http" : "https"}://${candidate}`;
}
