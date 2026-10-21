// What the Sent screen may count as a send. Pure (no server imports) so the
// client component and the server page share one definition.
//
// A row was only handed to a transport when its provider has an
// implementation in the emailProviders registry (lib/emails/providers/index.ts).
// "manual", and ids resolveEmailProvider can return without an implementation
// (sendgrid/postmark), are stored with status "sent" but nothing was sent.
// Keep this list equal to Object.keys(emailProviders) - a unit test asserts it.
export const TRANSPORT_PROVIDER_IDS: readonly string[] = ["resend", "smtp2go"];

// Statuses that mean the transport accepted (or delivered) the message.
// Excludes queued (never completed), failed, bounced and complained.
const COUNTED_STATUSES = new Set(["sent", "delivered"]);

export function wasHandedToTransport(row: { provider: string }): boolean {
  return TRANSPORT_PROVIDER_IDS.includes(row.provider.toLowerCase());
}

export function countSentEmails(rows: ReadonlyArray<{ provider: string; status: string }>): number {
  return rows.filter((r) => wasHandedToTransport(r) && COUNTED_STATUSES.has(r.status.toLowerCase())).length;
}
