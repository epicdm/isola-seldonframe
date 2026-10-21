// 2026-10-21 — Booking cancellation: calendar CANCEL + organizer notice
// (release 1).
//
// Defect fixed (Port):
//   def-uplink-booking-cancel-sends-no-calendar-cancel-or-organizer-notice-2026-10-21
//
// The original invite (booking-invite.ts) sent METHOD:REQUEST, UID
// booking-<id>@seldonframe.com, SEQUENCE 0, to the owner and the customer.
// On cancel this sends METHOD:CANCEL with the SAME UID, STATUS:CANCELLED and
// a SEQUENCE above every earlier one: metadata.icsSequence, incremented
// ATOMICALLY in SQL (no schema change), and the same statement stamps
// metadata.icsCancelledAt guarded by "not already stamped" — so the cancel is
// sent exactly once even if booking.cancelled fires twice.
//
// ONE email per recipient:
//   - CUSTOMER: the CANCEL .ics rides on the EXISTING cancellation email (the
//     booking-cancellation trigger) via `deliverToCustomer`. Only when that
//     email did not go out (trigger disabled, suppressed, owned by a deployed
//     agent, ...) is a dedicated "Cancelled: ..." email sent instead, so the
//     customer's calendar is still updated.
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
import { bookings } from "@/db/schema";
import { sendEmailFromApi, type ApiSendEmailResult } from "@/lib/emails/api";
import { loadSelectedBusinessCalendar, type SelectedBusinessCalendar } from "@/lib/bookings/business-calendar";
import { bookingIcsUid, loadInviteDataFromDb, type InviteData } from "./booking-invite";
import { buildBookingICS } from "./build-ics";

const ICS_FILENAME = "appointment.ics";

export type CalendarAttachment = { filename: string; content: string; contentType?: string };

type SendEmailFn = (params: {
  orgId: string;
  userId: string | null;
  contactId: string | null;
  toEmail: string;
  subject: string;
  body: string;
  attachments?: CalendarAttachment[];
}) => Promise<ApiSendEmailResult>;

/** Returned by the row-locked claim: the SEQUENCE plus the row's CURRENT
 *  times, read in the same statement. */
export type ClaimedSequence = { sequence: number; startsAt: Date; endsAt: Date };

export type BookingCancellationDeps = {
  loadSelected: (orgId: string) => Promise<SelectedBusinessCalendar | null>;
  loadInviteData: (orgId: string, bookingId: string) => Promise<InviteData | null>;
  /** Atomically bump metadata.icsSequence and stamp icsCancelledAt. Null →
   *  booking missing or the CANCEL was already sent. */
  claimCancel: (orgId: string, bookingId: string) => Promise<ClaimedSequence | null>;
  sendEmail: SendEmailFn;
  /** Whether the workspace has a connected (Composio) calendar. */
  hasConnectedCalendar: (orgId: string) => Promise<boolean>;
  now: () => Date;
};

async function defaultClaimCancel(orgId: string, bookingId: string): Promise<ClaimedSequence | null> {
  const meta = sql`COALESCE(${bookings.metadata}, '{}'::jsonb)`;
  const next = sql`jsonb_set(jsonb_set(${meta}, ARRAY['icsSequence']::text[], to_jsonb(COALESCE((${meta} ->> 'icsSequence')::int, 0) + 1), true), ARRAY['icsCancelledAt']::text[], to_jsonb(now()::text), true)`;
  const [row] = await db
    .update(bookings)
    .set({ metadata: next as unknown as typeof bookings.$inferInsert.metadata })
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, orgId), sql`(${meta} ->> 'icsCancelledAt') IS NULL`))
    .returning({ metadata: bookings.metadata, startsAt: bookings.startsAt, endsAt: bookings.endsAt });
  if (!row) return null;
  const sequence = Number(((row.metadata ?? {}) as Record<string, unknown>).icsSequence);
  if (!Number.isFinite(sequence) || sequence < 1) return null;
  return {
    sequence,
    startsAt: row.startsAt instanceof Date ? row.startsAt : new Date(row.startsAt),
    endsAt: row.endsAt instanceof Date ? row.endsAt : new Date(row.endsAt),
  };
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
  claimCancel: defaultClaimCancel,
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
export function buildCancelAttachment(data: InviteData, claimed: ClaimedSequence, now: Date): CalendarAttachment {
  const { booking, org } = data;
  const summary = booking.title && booking.title.trim() ? booking.title.trim() : `Appointment — ${org.name}`;
  const ics = buildBookingICS({
    uid: bookingIcsUid(booking.id),
    start: claimed.startsAt,
    end: claimed.endsAt,
    now,
    summary,
    description: `Appointment with ${org.name}.`,
    location: booking.location ?? undefined,
    organizerName: org.name,
    organizerEmail: org.fromEmail,
    attendeeName: booking.customerName ?? undefined,
    attendeeEmail: booking.customerEmail ?? undefined,
    method: "CANCEL",
    sequence: claimed.sequence,
  });
  return {
    filename: ICS_FILENAME,
    content: Buffer.from(ics, "utf8").toString("base64"),
    contentType: "text/calendar; method=CANCEL",
  };
}

export type CancellationResult =
  | { sent: true; customerVia: "existing_email" | "dedicated_email" | "none" }
  | { sent: false; reason: "not_selected" | "no_invite_data" | "already_cancelled_or_missing" | "failed" };

/**
 * Cancellation: CANCEL .ics (same UID, higher SEQUENCE, STATUS:CANCELLED) to
 * the customer — on the existing cancellation email when `deliverToCustomer`
 * sends it, else on a dedicated email — and the organizer/owner notice.
 * Never creates an event. Never throws.
 */
export async function sendBookingCalendarCancellation(
  input: { orgId: string; bookingId: string },
  opts: { deliverToCustomer?: (attachment: CalendarAttachment) => Promise<boolean> } = {},
  deps: BookingCancellationDeps = defaultBookingCancellationDeps,
): Promise<CancellationResult> {
  try {
    const selected = await deps.loadSelected(input.orgId).catch(() => null);
    if (!selected) return { sent: false, reason: "not_selected" };

    const data = await deps.loadInviteData(input.orgId, input.bookingId);
    if (!data) return { sent: false, reason: "no_invite_data" };

    const claimed = await deps.claimCancel(input.orgId, input.bookingId);
    if (!claimed) return { sent: false, reason: "already_cancelled_or_missing" };

    const attachment = buildCancelAttachment(data, claimed, deps.now());
    const summary = data.booking.title && data.booking.title.trim() ? data.booking.title.trim() : `Appointment — ${data.org.name}`;
    const whenLocal = formatLocal(claimed.startsAt, data.org.timezone);

    // CUSTOMER — one email.
    let customerVia: "existing_email" | "dedicated_email" | "none" = "none";
    if (opts.deliverToCustomer) {
      try {
        if (await opts.deliverToCustomer(attachment)) customerVia = "existing_email";
      } catch (err) {
        warn("calendar_cancel.customer_existing_email_failed", {
          orgId: input.orgId,
          bookingId: input.bookingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (customerVia === "none" && data.booking.customerEmail) {
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
        });
        customerVia = "dedicated_email";
      } catch (err) {
        warn("calendar_cancel.customer_send_failed", {
          orgId: input.orgId,
          bookingId: input.bookingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // OWNER / ORGANIZER — one notice, honest about what is not handled yet.
    if (data.ownerEmail) {
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
        });
      } catch (err) {
        warn("calendar_cancel.owner_send_failed", {
          orgId: input.orgId,
          bookingId: input.bookingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      warn("calendar_cancel.owner_skipped", { orgId: input.orgId, bookingId: input.bookingId, reason: "no_owner_email" });
    }
    return { sent: true, customerVia };
  } catch (err) {
    warn("calendar_cancel.failed", {
      orgId: input.orgId,
      bookingId: input.bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "failed" };
  }
}
