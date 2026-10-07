import { escapeHtml, resolvePlatformBranding, type PlatformBranding } from "@/lib/branding/platform";
import { selectPortalEmailTransport } from "@/lib/portal/email-transport";
import { sendSignInEmailViaSmtp2go } from "./signin-email-smtp2go";

export type AuthVerificationEmailInput = {
  identifier: string;
  url: string;
  provider: { apiKey?: string; from?: string };
};

type SignInEmailEnvironment = Record<string, string | undefined>;

export function hasPlatformSignInEmailTransport(env: SignInEmailEnvironment): boolean {
  return selectPortalEmailTransport(env).transport === "smtp2go" || Boolean(
    (env.AUTH_RESEND_KEY ?? env.RESEND_API_KEY)?.trim(),
  );
}

export function renderPlatformSignInEmail(input: {
  url: string;
  baseUrl: string;
  branding?: PlatformBranding;
}): { subject: string; html: string; text: string } {
  const brand = input.branding ?? resolvePlatformBranding();
  const name = escapeHtml(brand.name);
  const supportEmail = escapeHtml(brand.supportEmail);
  const homeUrl = escapeHtml(brand.homeUrl);
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const safeBaseUrl = escapeHtml(baseUrl);
  const safeUrl = escapeHtml(input.url);
  const subject = `Your ${brand.name} sign-in link`;
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" style="display:inline-block;max-width:220px;max-height:44px;object-fit:contain;" />`
    : `<strong style="font-size:22px;line-height:1.3;">${name}</strong>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0a0e1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;">
<tr><td style="padding:32px 32px 16px;text-align:center;">${logo}</td></tr>
<tr><td style="padding:8px 32px 0;text-align:center;"><h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:600;">Sign in to ${name}</h1>
<p style="margin:12px 0 0;font-size:15px;line-height:1.5;color:#6b7280;">Click below to sign in. This link is valid for 15 minutes and works once.</p></td></tr>
<tr><td style="padding:28px 32px 8px;text-align:center;"><a href="${safeUrl}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;">Sign in to ${name}</a></td></tr>
<tr><td style="padding:16px 32px 0;text-align:center;"><p style="margin:0;font-size:13px;color:#6b7280;">Button not working? Copy and paste this link:</p><p style="margin:8px 0 0;font-size:12px;word-break:break-all;"><a href="${safeUrl}">${safeUrl}</a></p></td></tr>
<tr><td style="padding:24px 32px 32px;border-top:1px solid #f1f3f5;text-align:center;"><p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">If you did not request this email, you can ignore it.<br />Questions? <a href="mailto:${supportEmail}">${supportEmail}</a> · <a href="${homeUrl}">${homeUrl}</a></p>
<p style="margin:16px 0 0;font-size:11px;color:#6b7280;">${escapeHtml(brand.emailFooter)} · <a href="${safeBaseUrl}/license">Open-source notices</a></p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `Sign in to ${brand.name}\n\nClick this link to sign in (valid for 15 minutes, single use):\n\n${input.url}\n\nIf you did not request this email, you can ignore it.\nQuestions? ${brand.supportEmail}\n${brand.emailFooter}\n${baseUrl}/license`;
  return { subject, html, text };
}

export function formatBrandedSender(from: string, displayName: string): string {
  const address = from.match(/<([^<>]+)>/)?.[1]?.trim() ?? from.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return from;
  return `${displayName.replace(/[<>\r\n]/g, "").trim()} <${address}>`;
}

export async function sendPlatformSignInEmail(
  params: AuthVerificationEmailInput,
  deps: { env?: SignInEmailEnvironment; fetcher?: typeof fetch } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const branding = resolvePlatformBranding(env);
  const baseUrl = (env.NEXTAUTH_URL?.trim() || env.AUTH_URL?.trim() || branding.appUrl).replace(/\/+$/, "");
  const email = renderPlatformSignInEmail({ url: params.url, baseUrl, branding });
  const transport = selectPortalEmailTransport(env);
  const fetcher = deps.fetcher ?? globalThis.fetch;

  if (transport.transport === "smtp2go") {
    await sendSignInEmailViaSmtp2go(
      { to: params.identifier, ...email },
      {
        apiKey: transport.apiKey,
        from: formatBrandedSender(transport.from, branding.emailFromName),
        fetcher,
      },
    );
    return;
  }

  const apiKey = env.AUTH_RESEND_KEY?.trim() || env.RESEND_API_KEY?.trim() || params.provider.apiKey?.trim();
  if (!apiKey) throw new Error("Sign-in email transport is not configured");

  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.provider.from ?? formatBrandedSender(env.AUTH_RESEND_FROM ?? env.DEFAULT_FROM_EMAIL ?? "hello@seldonframe.local", branding.emailFromName),
      to: params.identifier,
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "<no-body>");
    throw new Error(`Failed to send sign-in email (${response.status}): ${detail.slice(0, 200)}`);
  }
}

export function createPlatformVerificationEmailSender(
  deps: { env?: SignInEmailEnvironment; fetcher?: typeof fetch } = {},
) {
  return (params: AuthVerificationEmailInput) => sendPlatformSignInEmail(params, deps);
}
