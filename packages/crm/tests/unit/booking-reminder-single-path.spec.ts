// Single-path booking reminders (2026-10-21).
// Red on base fa073d79: the guards module does not exist, the workflow start
// is unconditional, and processScheduledSend has no past-start guard.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isBookingReminderWorkflowEnabled,
  isScheduledSendPastBookingStart,
} from "../../src/lib/messaging/reminder-guards";

const src = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

describe("path B gate — BOOKING_REMINDER_WORKFLOW", () => {
  test("absent / empty / other values => OFF (default)", () => {
    assert.equal(isBookingReminderWorkflowEnabled({}), false);
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: "" }), false);
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: "off" }), false);
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: "true" }), false);
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: "1" }), false);
  });
  test("positive control: 'on' (any case, trimmed) => ON", () => {
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: "on" }), true);
    assert.equal(isBookingReminderWorkflowEnabled({ BOOKING_REMINDER_WORKFLOW: " ON " }), true);
  });
});

describe("path A lateness guard", () => {
  const start = "2026-10-13T15:00:00.000Z";
  test("booking row after start => past (cancel)", () => {
    assert.equal(
      isScheduledSendPastBookingStart("booking.created", { startsAt: start }, new Date("2026-10-21T09:00:00Z")),
      true,
    );
  });
  test("positive control: before start (normal 24h reminder) => not past", () => {
    assert.equal(
      isScheduledSendPastBookingStart("booking.created", { startsAt: start }, new Date("2026-10-12T15:00:00Z")),
      false,
    );
    // late tick but still before the appointment => still sends
    assert.equal(
      isScheduledSendPastBookingStart("booking.created", { startsAt: start }, new Date("2026-10-13T14:59:00Z")),
      false,
    );
  });
  test("Date startsAt is handled too", () => {
    assert.equal(
      isScheduledSendPastBookingStart("booking.created", { startsAt: new Date(start) }, new Date("2026-10-14T00:00:00Z")),
      true,
    );
  });
  test("non-booking events and unparseable startsAt are never treated as late", () => {
    assert.equal(isScheduledSendPastBookingStart("form.submitted", { startsAt: start }, new Date("2030-01-01T00:00:00Z")), false);
    assert.equal(isScheduledSendPastBookingStart("booking.created", {}, new Date("2030-01-01T00:00:00Z")), false);
    assert.equal(isScheduledSendPastBookingStart("booking.created", { startsAt: "nope" }, new Date("2030-01-01T00:00:00Z")), false);
    assert.equal(isScheduledSendPastBookingStart("booking.created", null, new Date("2030-01-01T00:00:00Z")), false);
  });
});

describe("wiring on the real paths", () => {
  test("submitPublicBookingAction starts the workflow only behind the gate", () => {
    const s = src("lib/bookings/actions.ts");
    const startIdx = s.indexOf("start(bookingReminderWorkflow");
    assert.ok(startIdx > 0, "control: the workflow start call still exists");
    const gateIdx = s.lastIndexOf("isBookingReminderWorkflowEnabled(process.env)", startIdx);
    assert.ok(gateIdx > 0 && startIdx - gateIdx < 600, "start() must sit directly behind the env gate");
    assert.equal(s.split("start(bookingReminderWorkflow").length - 1, 1, "exactly one start site");
  });
  test("processScheduledSend cancels past-start rows before compose/send", () => {
    const s = src("lib/messaging/schedule.ts");
    const fn = s.indexOf("export async function processScheduledSend");
    const guard = s.indexOf('markScheduledSendCancelled(row.id, "past_start")', fn);
    const compose = s.indexOf("composeOutboundMessage(", fn);
    const send = s.indexOf("sendEmailFromApi(", fn);
    assert.ok(fn > 0 && compose > fn && send > fn, "control: compose and send exist in processScheduledSend");
    assert.ok(guard > fn && guard < compose && guard < send, "past_start guard runs before compose and send");
    assert.match(s.slice(fn, guard), /isScheduledSendPastBookingStart\(row\.eventType, row\.payload, new Date\(\)\)/);
  });
});
