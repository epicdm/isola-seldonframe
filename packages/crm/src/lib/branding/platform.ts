export type PlatformBranding = {
  name: string;
  operatorName: string;
  appUrl: string;
  homeUrl: string;
  supportEmail: string;
  emailFromName: string;
  emailFooter: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  sourceUrl: string | null;
  showVendorBranding: boolean;
};

type BrandingEnv = Record<string, string | undefined>;

function safeAssetUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  if (candidate.startsWith("/") && !candidate.startsWith("//")) return candidate;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeHttpsUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function cleanUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fallback;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function resolvePlatformBranding(env: BrandingEnv = process.env): PlatformBranding {
  const appUrl = cleanUrl(env.PLATFORM_APP_URL || env.NEXT_PUBLIC_APP_URL, "https://app.seldonframe.com");
  const name = env.PLATFORM_NAME?.trim() || "SeldonFrame";
  return {
    name,
    operatorName: env.PLATFORM_OPERATOR_NAME?.trim() || (name === "SeldonFrame" ? "SeldonFrame" : "the operator"),
    appUrl,
    homeUrl: cleanUrl(env.PLATFORM_HOME_URL, "https://www.seldonframe.com"),
    supportEmail: env.PLATFORM_SUPPORT_EMAIL?.trim() || "support@seldonframe.com",
    emailFromName: env.PLATFORM_EMAIL_FROM_NAME?.trim() || name,
    emailFooter: env.PLATFORM_EMAIL_FOOTER?.trim() || `The ${name} team`,
    logoUrl: safeAssetUrl(env.PLATFORM_LOGO_URL),
    faviconUrl: safeAssetUrl(env.PLATFORM_FAVICON_URL),
    sourceUrl: safeHttpsUrl(env.PLATFORM_SOURCE_URL),
    showVendorBranding: env.SHOW_VENDOR_BRANDING?.trim().toLowerCase() !== "false",
  };
}

export function resolveWorkspaceBaseDomain(env: BrandingEnv = process.env): string {
  const configured = env.WORKSPACE_BASE_DOMAIN?.trim();
  if (configured) return configured.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return new URL(resolvePlatformBranding(env).appUrl).host;
}

export function buildPlatformOrganizationWebsiteGraph(
  branding: PlatformBranding,
  description: string,
) {
  const organizationId = `${branding.appUrl}/#organization`;
  const websiteId = `${branding.appUrl}/#website`;
  return [
    {
      "@type": "Organization",
      "@id": organizationId,
      name: branding.name,
      url: branding.homeUrl,
      email: branding.supportEmail,
      description,
    },
    {
      "@type": "WebSite",
      "@id": websiteId,
      name: branding.name,
      url: branding.homeUrl,
      publisher: { "@id": organizationId },
    },
  ];
}

/** Platform branding can hide attribution only when the existing entitlement allows it. */
export function shouldShowVendorAttribution(input: {
  configuredVisible: boolean;
  entitledToRemove: boolean;
  workspaceRequestsRemoval: boolean | null;
}): boolean {
  if (!input.entitledToRemove) return true;
  if (!input.configuredVisible) return false;
  return input.workspaceRequestsRemoval !== true;
}

export function shouldServeBrandedRootPublicly(pathname: string, platformName: string): boolean {
  return pathname === "/" && platformName.trim() !== "" && platformName !== "SeldonFrame";
}

const brandedMarketingPrefixes = [
  "/pricing",
  "/pricing-public",
  "/agencies",
  "/blog",
  "/guides",
  "/charts",
  "/docs",
  "/demo",
  "/compare",
  "/alternatives",
  "/best",
  "/tools",
  "/ai-agents",
];

/** Hide upstream promotional surfaces on a white-label app host without hiding native operations. */
export function shouldHideVendorMarketingPath(pathname: string, platformName: string): boolean {
  if (!platformName.trim() || platformName === "SeldonFrame") return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (
    path === "/.well-known/openai-apps-challenge" ||
    path === "/home.md" ||
    path === "/index.md" ||
    path === "/llms.txt" ||
    path === "/ai-agents.md" ||
    path === "/build.md" ||
    path === "/SKILL.md"
  ) {
    return true;
  }

  if (brandedMarketingPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return true;
  }

  if (/^\/alternative-to-[^/]+(?:\.md)?$/.test(path) || /^\/[a-z0-9-]+-pricing(?:\.md)?$/.test(path)) {
    return true;
  }

  // This is the seller-promotion page with unverified vendor fee promises.
  // The native catalog, listing details, APIs, and Studio agent controls stay available.
  return path === "/marketplace/build" || path.startsWith("/marketplace/build/");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}
