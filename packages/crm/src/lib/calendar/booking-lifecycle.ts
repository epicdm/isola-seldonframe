// 2026-10-21 — Booking cancellation: calendar CANCEL + organizer notice
// (release 1).
//
// Defect fixed (Port):
//   def-uplink-booking-cancel-sends-no-calendar-cancel-or-organizer-notice-2026-10-21
//
// The original invite (booking-invite.ts) sent METHOD:REQUEST, UID
// booking-<id>@seldonframe.com, SEQUENCE 0, to the owner and the customer.
// On cancel this sends METHOD:CANCEL with the SAME UID, STATUS:CANCELLED and
// a SEQUENCE above every earlier one. The cancel SEQUENCE is assigned ONCE
// (metadata.icsCancelSequence, from an atomic bump of metadata.icsSequence)
// and reused by any retry, so every copy of the cancellation is identical.
//
// Delivery is tracked PER RECIPIENT in metadata.icsCancelDelivery
// ({customer|owner: {status:"sending"|"sent", at}}): a recipient is claimed
// atomically before sending, marked "sent" only after the send was confirmed,
// and released on failure — so a repeated booking.cancelled never re-sends to
// a recipient already served, while a failed recipient can still be served
// by a later attempt. A "sending" claim older than CLAIM_STALE_MS (process
// died mid-send) can be re-claimed.
//
// ONE email per recipient:
//   - CUSTOMER: the CANCEL .ics rides on the EXISTING cancellation email (the
//     booking-cancellation trigger) via `deliverToCustomer`, which tags that
//     email (emails.metadata.calendarCancelFor = bookingId). Delivery is
//     CONFIRMED from the emails row reaching status "sent" — which only
//     happens after the provider accepted it — so a failure in the send's own
//     post-processing never triggers a second email. Only when no such email
//     was sent is a dedicated "Cancelled: ..." email sent instead.
//   - OWNER: one cancellation notice carrying the CANCEL .ics (the owner got
//     the .ics invite at creation). If the workspace also has a connected
//     calendar, the notice says plainly that an automatically added copy is
//     NOT removed yet (release 2 manages that event).
//
// GATED: workspaces with a selected business calendar only
// (settings.bookingCalendar.calendarId). Everyone else: a no-op.
// SOFT-FAIL exactly like the invite path: nothing here throws.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, emails } from "@/db/schema";
import { sendEmailFromApi, type ApiSendEmailResult } from "@/lib/emails/api";
import { loadSelectedBusinessCalendar, type SelectedBusinessCalendar } from "@/lib/bookings/business-calendar";
import { bookingIcsUid, loadInviteDataFromDb, type InviteData } from "./booking-invite";
import { buildBookingICS } from "./build-ics";

const ICS_FILENAME = "appointment.ics";
export const CLAIM_STALE_MS = 10 * 60_000;
/** emails.metadata keys tagging the email that carried the CANCEL. */
export const CANCEL_EMAIL_TAG = "calendarCancelFor";
export const OWNER_CANCEL_EMAIL_TAG = "calendarCancelOwnerFor";

export type CalendarAttachment = { filename: string; content: string; contentType?: string };
export type Recipient = "customer" | "owner";

type SendEmailFn = (params: {
  orgId: string;
  userId: string | null;
  contactId: string | null;
  toEmail: string;
  subject: string;
  body: string;
  attachments?: CalendarAttachment[];
  metadata?: Record<string, unknown>;
}) => Promise<ApiSendEmailResult>;

/** The cancel SEQUENCE plus the row's CURRENT times. */
export type CancelSequence = { sequence: number; startsAt: Date; endsAt: Date };

export type BookingCancellationDeps = {
  loadSelected: (orgId: string) => Promise<SelectedBusinessCalendar | null>;
  loadInviteData: (orgId: string, bookingId: string) => Promise<InviteData | null>;
  /** Assign the cancel SEQUENCE once (atomic); return the assigned one. */
  cancelSequence: (orgId: string, bookingId: string) => Promise<CancelSequence | null>;
  /** Atomically claim a recipient (false → already sent / being sent). */
  claimRecipient: (orgId: string, bookingId: string, who: Recipient) => Promise<boolean>;
  /** "sent" after a confirmed send; "release" makes it retryable. */
  finishRecipient: (orgId: string, bookingId: string, who: Recipient, outcome: "sent" | "release") => Promise<void>;
  /** True when an email tagged for this booking's CANCEL (for `who`)
   *  reached "sent" — written only after the provider accepted it. */
  cancelEmailSent: (orgId: string, bookingId: string, who: Recipient) => Promise<boolean>;
  sendEmail: SendEmailFn;
  hasConnectedCalendar: (orgId: string) => Promise<boolean>;
  now: () => Date;
};

const meta = () => sql`COALESCE(${bookings.metadata}, '{}'::jsonb)`;

async function defaultCancelSequence(orgId: string, bookingId: string): Promise<CancelSequence | null> {
  const m = meta();
  const next = sql`COALESCE((${m} ->> 'icsSequence')::int, 0) + 1`;
  await db
    .update(bookings)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${m}, ARRAY['icsSequence']::text[], to_jsonb(${next}), true), ARRAY['icsCancelSequence']::text[], to_jsonb(${next}), true)`,
    })
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, orgId), sql`(${m} ->> 'icsCancelSequence') IS NULL`));
  const [row] = await db
    .select({ metadata: bookings.metadata, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  const sequence = Number(((row.metadata ?? {}) as Record<string, unknown>).icsCancelSequence);
  if (!Number.isFinite(sequence) || sequence < 1) return null;
  return {
    sequence,
    startsAt: row.startsAt instanceof Date ? row.startsAt : new Date(row.startsAt),
    endsAt: row.endsAt instanceof Date ? row.endsAt : new Date(row.endsAt),
  };
}

async function defaultClaimRecipient(orgId: string, bookingId: string, who: Recipient): Promise<boolean> {
  const m = meta();
  const entry = sql`(${m} -> 'icsCancelDelivery' -> ${who}::text)`;
  const rows = await db
    .update(bookings)
    .set({
      metadata: sql`jsonb_set(${m}, ARRAY['icsCancelDelivery']::text[], COALESCE(${m} -> 'icsCancelDelivery', '{}'::jsonb) || jsonb_build_object(${who}::text, jsonb_build_object('status', 'sending', 'at', now()::text)), true)`,
    })
    .where(
      and(
        eq(bookings.id, bookingId),
        eq(bookings.orgId, orgId),
        sql`(${entry} IS NULL OR ((${entry} ->> 'status') = 'sending' AND (${entry} ->> 'at')::timestamptz < now() - make_interval(secs => ${CLAIM_STALE_MS / 1000})))`,
      ),
    )
    .returning({ id: bookings.id });
  return rows.length > 0;
}

async function defaultFinishRecipient(
  orgId: string,
  bookingId: string,
  who: Recipient,
  outcome: "sent" | "release",
): Promise<void> {
  const m = meta();
  const value =
    outcome === "sent"
      ? sql`COALESCE(${m} -> 'icsCancelDelivery', '{}'::jsonb) || jsonb_build_object(${who}::text, jsonb_build_object('status', 'sent', 'at', now()::text))`
      : sql`COALESCE(${m} -> 'icsCancelDelivery', '{}'::jsonb) - ${who}::text`;
  await db
    .update(bookings)
    .set({ metadata: sql`jsonb_set(${m}, ARRAY['icsCancelDelivery']::text[], ${value}, true)` })
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, orgId)));
}

async function defaultCancelEmailSent(orgId: string, bookingId: string, who: Recipient): Promise<boolean> {
  const tag = who === "customer" ? CANCEL_EMAIL_TAG : OWNER_CANCEL_EMAIL_TAG;
  const rows = await db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        eq(emails.orgId, orgId),
        eq(emails.status, "sent"),
        sql`(${emails.metadata} ->> ${tag}::text) = ${bookingId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function defaultHasConnectedCalendar(orgId: string): Promise<boolean> {
  try {
    const { resolveOrgCalendarConnection } = await import("@/lib/bookings/business-calendar");
    return (await resolveOrgCalendarConnection(orgId)) !== null;
  } catch {
    return false;
  }
}

export const defaultBookingCancellationDeps: BookingCancellationDeps = {
  loadSelected: loadSelectedBusinessCalendar,
  loadInviteData: loadInviteDataFromDb,
  cancelSequence: defaultCancelSequence,
  claimRecipient: defaultClaimRecipient,
  finishRecipient: defaultFinishRecipient,
  cancelEmailSent: defaultCancelEmailSent,
  sendEmail: sendEmailFromApi,
  hasConnectedCalendar: defaultHasConnectedCalendar,
  now: () => new Date(),
};

function formatLocal(d: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function warn(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ event, ...fields }));
}

/** Pure: the CANCEL .ics attachment for a booking. */
export function buildCancelAttachment(data: InviteData, seq: CancelSequence, now: Date): CalendarAttachment {
  const { booking, org } = data;
  const summary = booking.title && booking.title.trim() ? booking.title.trim() : `Appointment — ${org.name}`;
  const ics = buildBookingICS({
    uid: bookingIcsUid(booking.id),
    start: seq.startsAt,
    end: seq.endsAt,
    now,
    summary,
    description: `Appointment with ${org.name}.`,
    location: booking.location ?? undefined,
    organizerName: org.name,
    organizerEmail: org.fromEmail,
    attendeeName: booking.customerName ?? undefined,
    attendeeEmail: booking.customerEmail ?? undefined,
    method: "CANCEL",
    sequence: seq.sequence,
  });
  return {
    filename: ICS_FILENAME,
    content: Buffer.from(ics, "utf8").toString("base64"),
    contentType: "text/calendar; method=CANCEL",
  };
}

export type CancellationResult =
  | {
      sent: true;
      customer: "existing_email" | "dedicated_email" | "already_sent" | "failed" | "no_email";
      owner: "sent" | "already_sent" | "failed" | "no_email";
    }
  | { sent: false; reason: "not_selected" | "no_invite_data" | "failed" };

/**
 * Cancellation: CANCEL .ics (same UID, higher SEQUENCE, STATUS:CANCELLED) to
 * the customer — on the existing cancellation email when `deliverToCustomer`
 * sends it (tagged with `emailMetadata`), else on a dedicated email — and the
 * organizer/owner notice. Never creates an event. Never throws.
 */
export async function sendBookingCalendarCancellation(
  input: { orgId: string; bookingId: string },
  opts: {
    deliverToCustomer?: (attachment: CalendarAttachment, emailMetadata: Record<string, unknown>) => Promise<void>;
  } = {},
  deps: BookingCancellationDeps = defaultBookingCancellationDeps,
): Promise<CancellationResult> {
  try {
    const selected = await deps.loadSelected(input.orgId).catch(() => null);
    if (!selected) return { sent: false, reason: "not_selected" };

    const data = await deps.loadInviteData(input.orgId, input.bookingId);
    if (!data) return { sent: false, reason: "no_invite_data" };

    const seq = await deps.cancelSequence(input.orgId, input.bookingId);
    if (!seq) return { sent: false, reason: "no_invite_data" };

    const attachment = buildCancelAttachment(data, seq, deps.now());
    const summary = data.booking.title && data.booking.title.trim() ? data.booking.title.trim() : `Appointment — ${data.org.name}`;
    const whenLocal = formatLocal(seq.startsAt, data.org.timezone);

    // CUSTOMER — at most one confirmed email.
    let customer: "existing_email" | "dedicated_email" | "already_sent" | "failed" | "no_email" = "no_email";
    if (await deps.claimRecipient(input.orgId, input.bookingId, "customer")) {
      let delivered = false;
      if (opts.deliverToCustomer) {
        try {
          await opts.deliverToCustomer(attachment, { [CANCEL_EMAIL_TAG]: input.bookingId });
        } catch (err) {
          warn("calendar_cancel.customer_existing_email_failed", {
            orgId: input.orgId,
            bookingId: input.bookingId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Confirmed from the persisted emails row (status "sent" is written
        // only after the provider accepted it).
        delivered = await deps.cancelEmailSent(input.orgId, input.bookingId, "customer").catch(() => false);
        if (delivered) customer = "existing_email";
      }
      if (!delivered && data.booking.customerEmail) {
        try {
          await deps.sendEmail({
            orgId: data.org.id,
            userId: null,
            contactId: null,
            toEmail: data.booking.customerEmail,
            subject: `Cancelled: ${summary}`,
            body: [
              data.booking.customerName ? `Hi ${data.booking.customerName},` : `Hi there,`,
              ``,
              `Your appointment with ${data.org.name} on ${whenLocal} (${data.org.timezone}) is cancelled.`,
              `The attached update removes it from your calendar.`,
              data.org.businessPhone ? `Questions? Call ${data.org.businessPhone}.` : ``,
              ``,
              `— ${data.org.name}`,
            ]
              .filter((l) => l !== ``)
              .join("\n"),
            attachments: [attachment],
            metadata: { [CANCEL_EMAIL_TAG]: input.bookingId },
          });
          delivered = true;
          customer = "dedicated_email";
        } catch (err) {
          // The provider may still have accepted it before a later step
          // failed: trust the persisted row, never guess.
          delivered = await deps.cancelEmailSent(input.orgId, input.bookingId, "customer").catch(() => false);
          customer = delivered ? "dedicated_email" : "failed";
          warn("calendar_cancel.customer_send_failed", {
            orgId: input.orgId,
            bookingId: input.bookingId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await deps
        .finishRecipient(input.orgId, input.bookingId, "customer", delivered || !data.booking.customerEmail ? "sent" : "release")
        .catch(() => undefined);
    } else {
      customer = "already_sent";
    }

    // OWNER / ORGANIZER — one notice, honest about what is not handled yet.
    let owner: "sent" | "already_sent" | "failed" | "no_email" = "no_email";
    if (!data.ownerEmail) {
      warn("calendar_cancel.owner_skipped", { orgId: input.orgId, bookingId: input.bookingId, reason: "no_owner_email" });
    } else if (await deps.claimRecipient(input.orgId, input.bookingId, "owner")) {
      try {
        const connected = await deps.hasConnectedCalendar(input.orgId).catch(() => false);
        await deps.sendEmail({
          orgId: data.org.id,
          userId: null,
          contactId: null,
          toEmail: data.ownerEmail,
          subject: `Booking cancelled: ${summary} — ${whenLocal}`,
          body: [
            `A booking was cancelled.`,
            ``,
            `${summary}`,
            `${whenLocal} (${data.org.timezone})`,
            data.booking.customerName ? `Customer: ${data.booking.customerName}` : ``,
            data.booking.customerEmail ? `Email: ${data.booking.customerEmail}` : ``,
            ``,
            `The attached cancellation removes it from your calendar.`,
            connected
              ? `If this booking was also added to your connected calendar automatically, delete it there — that copy is not removed automatically yet.`
              : ``,
          ]
            .filter((l) => l !== ``)
            .join("\n"),
          attachments: [attachment],
          metadata: { [OWNER_CANCEL_EMAIL_TAG]: input.bookingId },
        });
        owner = "sent";
        await deps.finishRecipient(input.orgId, input.bookingId, "owner", "sent").catch(() => undefined);
      } catch (err) {
        // Trust the persisted row: accepted-then-failed is still "sent".
        const accepted = await deps.cancelEmailSent(input.orgId, input.bookingId, "owner").catch(() => false);
        owner = accepted ? "sent" : "failed";
        await deps
          .finishRecipient(input.orgId, input.bookingId, "owner", accepted ? "sent" : "release")
          .catch(() => undefined);
        warn("calendar_cancel.owner_send_failed", {
          orgId: input.orgId,
          bookingId: input.bookingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      owner = "already_sent";
    }
    return { sent: true, customer, owner };
  } catch (err) {
    warn("calendar_cancel.failed", {
      orgId: input.orgId,
      bookingId: input.bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "failed" };
  }
}
