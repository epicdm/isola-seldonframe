// EPIC 2026-10-12 (AGPL-3.0 section 5(a) modification notice): configuration for the
// branded platform storefront served at the root of a white-label host.
//
// THE SWITCH: PLATFORM_PERSONAL_LINE_SIGNUP
//   "open"  (exact, case-insensitive)  -> the real Personal Line sign-up CTA is shown.
//   anything else, including unset     -> the CTA is replaced by an honest "temporarily
//                                         unavailable" notice (fail closed, no dead button).
// The value is read at REQUEST time, so changing the EasyPanel environment value and
// restarting the service is enough; no rebuild.

import type { PlatformBranding } from "./platform";

type StorefrontEnv = Record<string, string | undefined>;

export const DEFAULT_PERSONAL_LINE_URL = "https://uplinks-workspace-4816.uplink.epic.dm";

export type StorefrontConfig = {
  personalLine: {
    signupOpen: boolean;
    /** Where the CTA goes. Null whenever signup is not open: there is no link to click. */
    ctaHref: string | null;
    ctaLabel: string;
    /** Honest status text, shown only when signup is not open. */
    notice: string | null;
    /** Mailto for people who want to be told when it is back. */
    contactHref: string;
  };
  business: { contactHref: string };
  signIn: { href: string };
  supportEmail: string;
};

function httpsUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return fallback;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function isPersonalLineSignupOpen(env: StorefrontEnv = process.env): boolean {
  return env.PLATFORM_PERSONAL_LINE_SIGNUP?.trim().toLowerCase() === "open";
}

export function resolveStorefront(brand: PlatformBranding, env: StorefrontEnv = process.env): StorefrontConfig {
  const signupOpen = isPersonalLineSignupOpen(env);
  const support = brand.supportEmail;
  return {
    personalLine: {
      signupOpen,
      ctaHref: signupOpen ? httpsUrl(env.PLATFORM_PERSONAL_LINE_URL, DEFAULT_PERSONAL_LINE_URL) : null,
      ctaLabel: signupOpen ? "Start your free trial" : "Sign-up temporarily unavailable",
      notice: signupOpen
        ? null
        : `Personal Line sign-up is temporarily unavailable while ${brand.operatorName} restores the service. We do not have a date to announce yet. Email ${support} and we will contact you when sign-up reopens.`,
      contactHref: `mailto:${support}?subject=${encodeURIComponent("Personal Line: tell me when sign-up reopens")}`,
    },
    business: {
      contactHref: `mailto:${support}?subject=${encodeURIComponent("Business services enquiry")}`,
    },
    signIn: { href: `${brand.appUrl}/login` },
    supportEmail: support,
  };
}
