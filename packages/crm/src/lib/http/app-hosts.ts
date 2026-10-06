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
    const host = new URL(origin).host;
    if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

export function extraAppHosts(env: Record<string, string | undefined> = process.env): string[] {
  return parseAppHosts(env.APP_HOSTS);
}

export function canonicalAppOrigin(env: Record<string, string | undefined> = process.env): string {
  const publicOrigin = env.NEXT_PUBLIC_APP_URL?.trim();
  const authOrigin = (env.AUTH_URL ?? env.NEXTAUTH_URL)?.trim();
  const publicNormalized = publicOrigin ? normalizedOrigin(publicOrigin) : null;
  const authNormalized = authOrigin ? normalizedOrigin(authOrigin) : null;

  if (publicOrigin && !publicNormalized) {
    throw new Error("NEXT_PUBLIC_APP_URL must be a valid HTTP(S) origin");
  }
  if (authOrigin && !authNormalized) {
    throw new Error("AUTH_URL must be a valid HTTP(S) origin");
  }
  if (publicNormalized && authNormalized && publicNormalized !== authNormalized) {
    throw new Error("AUTH_URL and NEXT_PUBLIC_APP_URL must use the same canonical origin");
  }

  return authNormalized ?? publicNormalized ?? DEFAULT_VENDOR_APP_ORIGIN;
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
