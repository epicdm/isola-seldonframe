// EPIC 2026-10-04 -- which service sends portal sign-in codes.
//
// SMTP2GO wins whenever BOTH its key and a sender (PORTAL_EMAIL_FROM) are set, even when a Resend key is also present:
// an old or invalid Resend key must not take over delivery. Resend is used only when SMTP2GO is not fully configured.
// AUTH_RESEND_KEY belongs to the sign-in provider and is deliberately never read here.

export type PortalEmailTransport =
  | { transport: "smtp2go"; apiKey: string; from: string }
  | { transport: "resend"; apiKey: string }
  | { transport: "none" };

export function selectPortalEmailTransport(env: Record<string, string | undefined>): PortalEmailTransport {
  const smtp2goKey = env.SMTP2GO_API_KEY?.trim() ?? "";
  const from = env.PORTAL_EMAIL_FROM?.trim() ?? "";
  if (smtp2goKey && from) return { transport: "smtp2go", apiKey: smtp2goKey, from };
  const resendKey = env.RESEND_API_KEY?.trim() ?? "";
  if (resendKey) return { transport: "resend", apiKey: resendKey };
  return { transport: "none" };
}
