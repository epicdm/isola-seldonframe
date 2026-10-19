// EPIC 2026-10-06 -- dashboard sign-in email through SMTP2GO.
//
// The NextAuth email provider (auth/config.ts) posts to api.resend.com with
// AUTH_RESEND_KEY. A self-hoster without a Resend account has a placeholder key,
// so "Send sign-in link" never delivered. When SMTP2GO_API_KEY + PORTAL_EMAIL_FROM are set
// (same selection rule as the portal access code: lib/portal/email-transport.ts) the link is sent
// through SMTP2GO instead. Never-lies: any failure THROWS so NextAuth shows its error page rather
// than "check your inbox" for a mail that was not sent.

export type Smtp2goSignInDeps = { apiKey: string; from: string; fetcher?: typeof fetch };

export async function sendSignInEmailViaSmtp2go(
  msg: { to: string; subject: string; html: string; text: string },
  deps: Smtp2goSignInDeps,
): Promise<{ messageId: string }> {
  const fetcher = deps.fetcher ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetcher("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: { "X-Smtp2go-Api-Key": deps.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: deps.from, to: [msg.to], subject: msg.subject, html_body: msg.html, text_body: msg.text }),
    });
  } catch (err) {
    // contract:throw-ok: surfaced by NextAuth as an error page (see header)
    throw new Error(`Failed to send sign-in email (SMTP2GO unreachable): ${err instanceof Error ? err.message : String(err)}`);
  }
  let payload: { data?: { succeeded?: number; email_id?: string; error?: string; error_code?: string } } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (!res.ok || Number(payload.data?.succeeded ?? 0) < 1) {
    const detail = payload.data?.error ?? payload.data?.error_code ?? `status ${res.status}`;
    // contract:throw-ok: surfaced by NextAuth as an error page (see header)
    throw new Error(`Failed to send sign-in email (SMTP2GO ${res.status}): ${String(detail).slice(0, 200)}`);
  }
  return { messageId: payload.data?.email_id ?? "" };
}
