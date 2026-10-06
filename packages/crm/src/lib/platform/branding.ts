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
  const homeUrl = optionalUrl(env.PLATFORM_HOME_URL, DEFAULT_HOME);
  const logoUrl = optionalUrl(env.PLATFORM_LOGO_URL, "/brand/seldonframe-wordmark.svg");
  const faviconUrl = optionalUrl(env.PLATFORM_FAVICON_URL, "/brand/seldonframe-favicon.svg");
  const appUrl = optionalUrl(
    env.PLATFORM_APP_URL ?? env.AUTH_URL ?? env.NEXT_PUBLIC_APP_URL,
    "https://app.seldonframe.com",
  );
  const supportEmail = optionalText(env.PLATFORM_SUPPORT_EMAIL, DEFAULT_SUPPORT);
  const emailFromName = optionalText(env.PLATFORM_EMAIL_FROM_NAME, name);
  const emailFooter = optionalText(
    env.PLATFORM_EMAIL_FOOTER,
    `© ${new Date().getUTCFullYear()} ${name}`,
  );
  const showVendorBranding = env.SHOW_VENDOR_BRANDING === undefined
    ? true
    : !["false", "0", "no"].includes(env.SHOW_VENDOR_BRANDING.trim().toLowerCase());

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
