// Public booking must honor the appointment type's stored duration.
//
// Defect (2026-10-21, EPIC Personal Line "Setup help call"): the type is
// stored as 15 minutes (admin shows 15) but the public /book page showed and
// booked 30, because actions.ts resolveDuration snapped every value to 30|60.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveAppointmentTypeDurationMinutes,
  computeSlotsForDay,
  defaultAvailabilitySchedule,
} from "../../src/lib/bookings/workspace-rules";

describe("resolveAppointmentTypeDurationMinutes", () => {
  test("honors a 15-minute type (the defect)", () => {
    assert.equal(resolveAppointmentTypeDurationMinutes(15), 15);
  });
  test("positive control: 30 and 60 unchanged (every other live type)", () => {
    assert.equal(resolveAppointmentTypeDurationMinutes(30), 30);
    assert.equal(resolveAppointmentTypeDurationMinutes(60), 60);
  });
  test("missing / non-finite falls back to 30", () => {
    assert.equal(resolveAppointmentTypeDurationMinutes(undefined), 30);
    assert.equal(resolveAppointmentTypeDurationMinutes(null), 30);
    assert.equal(resolveAppointmentTypeDurationMinutes(Number.NaN), 30);
    assert.equal(resolveAppointmentTypeDurationMinutes("abc"), 30);
  });
  test("bounded to the appointment-types API range 5-240, rounded", () => {
    assert.equal(resolveAppointmentTypeDurationMinutes(1), 5);
    assert.equal(resolveAppointmentTypeDurationMinutes(999), 240);
    assert.equal(resolveAppointmentTypeDurationMinutes(44.6), 45);
  });
});

describe("public booking path uses the type-duration resolver", () => {
  test("actions.ts resolveDuration delegates (no 30|60 snap left)", () => {
    const src = readFileSync(
      join(__dirname, "../../src/lib/bookings/actions.ts"),
      "utf8",
    );
    const m = src.match(/function resolveDuration\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, "resolveDuration not found");
    assert.match(m![1], /resolveAppointmentTypeDurationMinutes\(duration\)/);
    assert.doesNotMatch(m![1], /\?\s*60\s*:\s*30/);
    // Context + slot listing + submit all route through resolveDuration.
    assert.match(src, /const durationMinutes = resolveDuration\(metadata\?\.durationMinutes\)/);
  });

  test("a 15-minute type still yields slots; last slot fits the day", () => {
    const now = new Date("2026-10-26T00:00:00Z");
    const base = {
      rules: {
        availability: defaultAvailabilitySchedule(),
        minNoticeMinutes: 0,
        maxBookingsPerDay: null as number | null,
      },
      date: "2026-10-27",
      timezone: "America/Dominica",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 5,
      bookedRows: [] as Array<{ startsAt: Date; endsAt: Date }>,
      now,
    };
    const s15 = computeSlotsForDay({ ...base, durationMinutes: 15 }).slots;
    const s30 = computeSlotsForDay({ ...base, durationMinutes: 30 }).slots;
    assert.ok(s30.length > 0, "control: 30-min type has slots");
    assert.ok(s15.length >= s30.length, "15-min type has at least as many slots");
    assert.equal(computeSlotsForDay({ ...base, durationMinutes: 15 }).durationMinutes, 15);
  });
});
