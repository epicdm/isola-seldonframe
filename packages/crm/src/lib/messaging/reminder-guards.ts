// 2026-10-21 — single-path booking reminders.
//
// Two paths could each send the 24h booking reminder for the same booking:
//   A. outbound_scheduled_sends (trigger booking-reminder-24h, fired by the
//      /api/cron/outbound-scheduled-sends tick; per-row claim locking)
//   B. the Workflow DevKit bookingReminderWorkflow started on every public
//      booking (in-process timer in the local world)
// Nothing stopped A and B both sending. Path B is now OFF unless explicitly
// enabled, and path A refuses to send a booking.* row once the appointment
// has started (stale rows left behind while the scheduler was not running).
//
// Pure helpers only — no DB / Next imports — so they are unit-testable.

/** Path B gate. Enabled ONLY when BOOKING_REMINDER_WORKFLOW is exactly "on"
 *  (case/whitespace-insensitive). Absent, empty or anything else => OFF. */
export function isBookingReminderWorkflowEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return (env.BOOKING_REMINDER_WORKFLOW ?? "").trim().toLowerCase() === "on";
}

/** Path A lateness guard. True when the row is a booking.* event whose
 *  payload carries a valid startsAt that is already in the past (now >
 *  startsAt). Rows without a parseable startsAt are NOT treated as late. */
export function isScheduledSendPastBookingStart(
  eventType: string,
  payload: unknown,
  now: Date,
): boolean {
  if (!eventType.startsWith("booking.")) return false;
  if (!payload || typeof payload !== "object") return false;
  const raw = (payload as Record<string, unknown>).startsAt;
  let startsAt: Date | null = null;
  if (raw instanceof Date) startsAt = raw;
  else if (typeof raw === "string" && raw.trim()) startsAt = new Date(raw);
  if (!startsAt || Number.isNaN(startsAt.getTime())) return false;
  return now.getTime() > startsAt.getTime();
}
