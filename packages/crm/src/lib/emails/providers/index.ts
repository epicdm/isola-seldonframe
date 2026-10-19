import { findAdapterById } from "@seldonframe/core/integrations";
import { resendProvider } from "./resend";
import { smtp2goProvider, smtp2goSender } from "./smtp2go";
import type { EmailProvider } from "./interface";

export { resendProvider } from "./resend";
export { smtp2goProvider } from "./smtp2go";
export type {
  EmailProvider,
  EmailSendRequest,
  EmailSendResult,
  EmailSendFailure,
  EmailAttachment,
} from "./interface";
export { EmailProviderSendError } from "./interface";

// Provider registry keyed by id. v1 ships Resend only; SendGrid / Postmark
// land when real demand surfaces. The interface is deliberately small so
// adding a new provider is a new file + one registry entry.
export const emailProviders: Record<string, EmailProvider> = {
  resend: resendProvider,
  smtp2go: smtp2goProvider,
};

export function getEmailProvider(id: string): EmailProvider | null {
  return emailProviders[id] ?? null;
}

// Discovery order for picking a default when no override is supplied.
// Kept as a tuple so legacy call sites can iterate without casting.
export const emailProviderOrder = ["resend", "sendgrid", "postmark"] as const;

export type EmailProviderId = (typeof emailProviderOrder)[number] | "smtp2go" | "manual";

export async function getAvailableEmailProviders() {
  const checks = await Promise.all(
    emailProviderOrder.map(async (id) => {
      const descriptor = await findAdapterById(id);
      return descriptor && descriptor.adapter.isConfigured() ? id : null;
    })
  );

  return checks.filter((item): item is (typeof emailProviderOrder)[number] => Boolean(item));
}

export async function resolveEmailProvider(requested?: string | null): Promise<EmailProviderId> {
  const available = await getAvailableEmailProviders();

  if (requested && available.includes(requested as (typeof emailProviderOrder)[number])) {
    return requested as EmailProviderId;
  }

  if (available.includes("resend")) {
    return "resend";
  }

  // A real Resend key (workspace BYO or platform) keeps priority. Without one, use the SMTP2GO transport the
  // sign-in/portal mail already runs on instead of falling through to "manual" (which delivers nothing).
  if (await smtp2goProvider.isConfigured("")) {
    return "smtp2go";
  }

  return available[0] ?? "manual";
}

export function resolveDefaultFromEmail() {
  return process.env.DEFAULT_FROM_EMAIL ?? "hello@seldonframe.local";
}

/** The sender the chosen provider will really use. SMTP2GO only sends from its verified sender. */
export function resolveSenderForProvider(provider: EmailProviderId, fromEmail: string): string {
  return provider === "smtp2go" ? (smtp2goSender() ?? fromEmail) : fromEmail;
}
