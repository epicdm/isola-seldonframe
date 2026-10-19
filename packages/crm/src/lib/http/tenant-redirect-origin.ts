import { resolvePlatformBranding } from "@/lib/branding/platform";
import { resolveWorkspaceSlugFromHostHeader } from "@/lib/workspace/host-to-slug";
import { canonicalAppOrigin, extraAppHosts } from "./app-hosts";

function forwardedHost(request: Request): string | null {
  const value = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host")?.trim();
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    if (parsed.port && parsed.port !== "443") return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

async function isVerifiedCustomTenantDomain(hostname: string, orgSlug: string): Promise<boolean> {
  const { resolveWorkspaceForCustomDomain } = await import("@/lib/domains/store");
  const customDomain = await resolveWorkspaceForCustomDomain(hostname);
  if (!customDomain) return false;
  const { db } = await import("@/db");
  const { organizations } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [workspace] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, customDomain.workspace_id), eq(organizations.slug, orgSlug)))
    .limit(1);
  return Boolean(workspace);
}

/**
 * Preserve workspace-domain portal sessions while refusing arbitrary Host headers.
 * Unknown hosts fall back to the configured platform origin.
 */
export async function tenantRedirectOrigin(
  request: Request,
  orgSlug: string,
  checkCustomDomain: (hostname: string, orgSlug: string) => Promise<boolean> = isVerifiedCustomTenantDomain,
): Promise<string> {
  const host = forwardedHost(request);
  if (!host) return canonicalAppOrigin();

  const hostname = host.replace(/:\d+$/, "");
  const appHosts = new Set([
    new URL(canonicalAppOrigin()).host.toLowerCase(),
    ...extraAppHosts().map((item) => item.toLowerCase()),
  ]);
  if (appHosts.has(host.toLowerCase())) return canonicalAppOrigin();

  const workspaceSlug = resolveWorkspaceSlugFromHostHeader(hostname);
  if (workspaceSlug === orgSlug.toLowerCase()) return `https://${host}`;

  if (await checkCustomDomain(hostname, orgSlug)) return `https://${host}`;

  return resolvePlatformBranding().appUrl;
}
