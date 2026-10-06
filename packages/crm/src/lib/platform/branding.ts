import { canonicalAppOrigin } from "@/lib/http/app-hosts";

const DEFAULT_NAME = "SeldonFrame";
const DEFAULT_HOME = "https://www.seldonframe.com";
const DEFAULT_SUPPORT = "support@seldonframe.com";

function optionalUrl(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  if (value.trim().startsWith("/") && !value.trim().startsWith("//")) return value.trim();
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function optionalText(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  return text && text.length <= 300 ? text : fallback;
}

export type PlatformBranding = {
  name: string;
  appUrl: string;
  homeUrl: string;
  supportEmail: string;
  logoUrl: string;
  faviconUrl: string;
  emailFromName: string;
  emailFooter: string;
  showVendorBranding: boolean;
};

export function getPlatformBranding(
  env: Record<string, string | undefined> = process.env,
): PlatformBranding {
  const name = optionalText(env.PLATFORM_NAME, DEFAULT_NAME);
  const customBrand = name !== DEFAULT_NAME;
  const appUrl = canonicalAppOrigin(env);
  const homeFallback = customBrand ? appUrl : DEFAULT_HOME;
  const homeUrl = env.PLATFORM_HOME_URL?.trim()
    ? (() => {
        try {
          const url = new URL(env.PLATFORM_HOME_URL.trim());
          return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : homeFallback;
        } catch {
          return homeFallback;
        }
      })()
    : homeFallback;
  const showVendorBranding = env.SHOW_VENDOR_BRANDING === undefined
    ? true
    : !["false", "0", "no"].includes(env.SHOW_VENDOR_BRANDING.trim().toLowerCase());
  const logoUrl = env.PLATFORM_LOGO_URL?.trim()
    ? optionalUrl(env.PLATFORM_LOGO_URL, "")
    : customBrand && !showVendorBranding ? "" : "/brand/seldonframe-wordmark.svg";
  const faviconUrl = env.PLATFORM_FAVICON_URL?.trim()
    ? optionalUrl(env.PLATFORM_FAVICON_URL, "")
    : customBrand && !showVendorBranding ? "" : "/brand/seldonframe-favicon.svg";
  const supportEmail = optionalText(env.PLATFORM_SUPPORT_EMAIL, customBrand ? "" : DEFAULT_SUPPORT);
  const emailFromName = optionalText(env.PLATFORM_EMAIL_FROM_NAME, name);
  const emailFooter = optionalText(
    env.PLATFORM_EMAIL_FOOTER,
    `© ${new Date().getUTCFullYear()} ${name}`,
  );
  return {
    name,
    appUrl,
    homeUrl,
    supportEmail,
    logoUrl,
    faviconUrl,
    emailFromName,
    emailFooter,
    showVendorBranding,
  };
}
