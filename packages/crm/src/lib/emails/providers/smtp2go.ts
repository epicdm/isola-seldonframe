// EPIC 2026-10-09 -- workspace email (booking confirmation, calendar invite, new-booking alert) through the
// SAME SMTP2GO transport that already delivers sign-in links and portal access codes.
//
// Why: on a deployment without a Resend key the provider resolved to "manual", which writes the row and delivers
// nothing. SMTP2GO is configured there (SMTP2GO_API_KEY + PORTAL_EMAIL_FROM), so reuse it instead of asking for
// another vendor key. The selection rule is lib/portal/email-transport.ts -- not re-implemented here.
// SMTP2GO only sends from a verified sender, so the sender is PORTAL_EMAIL_FROM, never request.from
// (resolveDefaultFromEmail() is a *.local placeholder that SMTP2GO would reject).
import { selectPortalEmailTransport } from "@/lib/portal/email-transport";
import {
  EmailProviderSendError,
  type EmailProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./interface";

function smtp2goConfig() {
  const selected = selectPortalEmailTransport(process.env);
  return selected.transport === "smtp2go" ? selected : null;
}

/** The sender SMTP2GO will actually use (undefined when SMTP2GO is not configured). */
export function smtp2goSender(): string | undefined {
  return smtp2goConfig()?.from;
}

export const smtp2goProvider: EmailProvider = {
  id: "smtp2go",

  async isConfigured() {
    return smtp2goConfig() !== null;
  },

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const config = smtp2goConfig();
    if (!config) {
      throw new EmailProviderSendError("smtp2go", "SMTP2GO is not configured", { retriable: false });
    }
    const doFetch = request.fetcher ?? fetch;
    const attachments = (request.attachments ?? []).map((a) => ({
      filename: a.filename,
      fileblob: a.content,
      mimetype: a.contentType ?? "application/octet-stream",
    }));
    const response = await doFetch("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: {
        "X-Smtp2go-Api-Key": config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: config.from,
        to: [request.to],
        subject: request.subject,
        html_body: request.html,
        text_body: request.text,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    });

    let payload: { data?: { succeeded?: number; email_id?: string; error?: string; error_code?: string } } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    // Never-lies: a 200 with succeeded=0 is a failure, not a delivery.
    if (!response.ok || Number(payload.data?.succeeded ?? 0) < 1) {
      const detail = payload.data?.error ?? payload.data?.error_code ?? `status ${response.status}`;
      throw new EmailProviderSendError("smtp2go", `SMTP2GO send failed: ${String(detail).slice(0, 200)}`, {
        retriable: response.status >= 500 || response.status === 429,
        details: payload.data,
      });
    }
    return { externalMessageId: payload.data?.email_id ?? `smtp2go-${Date.now()}`, provider: "smtp2go" };
  },
};
