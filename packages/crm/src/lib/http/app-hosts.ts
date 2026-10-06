const DEFAULT_VENDOR_APP_ORIGIN = "https://app.seldonframe.com";

function normalizedOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseAppHosts(raw: string | undefined): string[] {
  const hosts = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const value = item.trim();
    if (!value) continue;
    const origin = normalizedOrigin(value.includes("://") ? value : `https://${value}`);
    if (!origin) continue;
    const host = new URL(origin).hostname;
    if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

export function extraAppHosts(env: Record<string, string | undefined> = process.env): string[] {
  return parseAppHosts(env.APP_HOSTS);
}

export function canonicalAppOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured: Array<[string, string | undefined]> = [
    ["PLATFORM_APP_URL", env.PLATFORM_APP_URL?.trim()],
    ["NEXT_PUBLIC_APP_URL", env.NEXT_PUBLIC_APP_URL?.trim()],
    ["AUTH_URL", (env.AUTH_URL ?? env.NEXTAUTH_URL)?.trim()],
  ];
  const configuredOrigins: Array<[string, string]> = [];
  for (const [key, value] of configured) {
    if (!value) continue;
    const origin = normalizedOrigin(value);
    if (!origin) throw new Error(`${key} must be a valid HTTP(S) origin`);
    configuredOrigins.push([key, origin]);
  }
  const canonical = configuredOrigins[0]?.[1] ?? DEFAULT_VENDOR_APP_ORIGIN;
  if (configuredOrigins.some(([, origin]) => origin !== canonical)) {
    throw new Error("PLATFORM_APP_URL, AUTH_URL, and NEXT_PUBLIC_APP_URL must use the same canonical origin");
  }
  return canonical;
}

export function primaryAppHost(env: Record<string, string | undefined> = process.env): string {
  return new URL(canonicalAppOrigin(env)).host.toLowerCase();
}

export function buildWorkspaceAdminRedirectUrl(
  orgId: string,
  pathname: string,
  search: string,
  env: Record<string, string | undefined> = process.env,
): URL | null {
  if (!orgId) return null;
  const target = new URL("/switch-workspace", canonicalAppOrigin(env));
  target.searchParams.set("to", orgId);
  target.searchParams.set("next", `${pathname}${search}`);
  return target;
}

export function workspaceBaseDomain(env: Record<string, string | undefined> = process.env): string {
  return env.WORKSPACE_BASE_DOMAIN?.trim() || new URL(canonicalAppOrigin(env)).hostname;
}
