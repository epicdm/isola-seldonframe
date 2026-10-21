// 2026-10-21 — pure helpers behind the selected-business-calendar gate.
// Response fixtures mirror the LIVE read-only FIND_FREE_SLOTS shapes observed
// on EPIC's connection (ca_tK1cUjDlHYzX) on 2026-10-21: a readable calendar
// returns { busy, free }; an unreadable one returns { errors:[{reason}],
// busy:[] } WITH successful=true — which must be a failure, never "free".
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUSY_RATE_LIMIT,
  __resetBusinessCalendarCacheForTests,
  checkBusinessCalendarBusy,
  filterSlotsOutsideBusy,
  naiveLocalDateTime,
  parseFreeSlotsBusy,
  resolveSelectedBusinessCalendar,
} from "@/lib/bookings/business-calendar";

const CAL = "meet@calendar.epic.dm";

test("gate: only an explicit non-empty calendarId selects a calendar", () => {
  assert.deepEqual(resolveSelectedBusinessCalendar({ bookingCalendar: { calendarId: ` ${CAL} ` } }), { calendarId: CAL });
  for (const s of [null, {}, { booking: {} }, { bookingCalendar: {} }, { bookingCalendar: { calendarId: "  " } }, { bookingCalendar: { calendarId: 7 } }]) {
    assert.equal(resolveSelectedBusinessCalendar(s), null, JSON.stringify(s));
  }
});

test("parse: readable calendar → busy windows (positive control)", () => {
  const r = parseFreeSlotsBusy(
    { successful: true, data: { calendars: { [CAL]: { busy: [{ start: "2026-10-22T08:00:00-04:00", end: "2026-10-22T08:45:00-04:00" }], free: [] } } } },
    CAL,
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.busy[0].start.toISOString(), "2026-10-22T12:00:00.000Z");
});

test("parse: errors / missing calendar / unsuccessful / bad shape all FAIL (never read as free)", () => {
  const cases: Array<[unknown, string]> = [
    [{ successful: true, data: { calendars: { [CAL]: { busy: [], free: [], errors: [{ domain: "global", reason: "notFound" }] } } } }, "calendar_error:notFound"],
    [{ successful: true, data: { calendars: { primary: { busy: [] } } } }, "calendar_missing"],
    [{ successful: false, error: "x" }, "unsuccessful"],
    [{ successful: true, data: {} }, "no_calendars"],
    [{ successful: true, data: { calendars: { [CAL]: { free: [] } } } }, "no_busy_array"],
    [{ successful: true, data: "{not json" }, "unparseable_data"],
    [null, "no_response"],
  ];
  for (const [res, reason] of cases) {
    assert.deepEqual(parseFreeSlotsBusy(res, CAL), { ok: false, reason });
  }
  // JSON-string data (the catalog declares data: string) is accepted.
  const s = parseFreeSlotsBusy({ successful: true, data: JSON.stringify({ calendars: { [CAL]: { busy: [] } } }) }, CAL);
  assert.deepEqual(s, { ok: true, busy: [] });
});

test("filter: removes only slots overlapping busy time (end-exclusive)", () => {
  const busy = [{ start: new Date("2026-10-22T13:00:00Z"), end: new Date("2026-10-22T14:00:00Z") }];
  const slots = ["2026-10-22T12:30:00.000Z", "2026-10-22T13:00:00.000Z", "2026-10-22T13:30:00.000Z", "2026-10-22T14:00:00.000Z"];
  assert.deepEqual(filterSlotsOutsideBusy(slots, 30, busy), ["2026-10-22T12:30:00.000Z", "2026-10-22T14:00:00.000Z"]);
  assert.deepEqual(filterSlotsOutsideBusy(slots, 30, []), slots, "control: no busy → unchanged");
});

test("naive local time in the workspace timezone (the format used live)", () => {
  assert.equal(naiveLocalDateTime(new Date("2026-10-22T04:00:00Z"), "America/Dominica"), "2026-10-22T00:00:00");
});

test("check: not selected -> no lookup; selected but no connection / outlook / throw -> unavailable (unreadable settings: see P3)", async () => {
  let executed = 0;
  const base = {
    getConnection: async () => ({ provider: "googlecalendar" as const, connectedAccountId: "ca_1" }),
    executeTool: async () => { executed += 1; return { successful: true, data: { calendars: { [CAL]: { busy: [] } } } }; },
  };
  const range = { orgId: "o", timeMin: new Date("2026-10-22T04:00:00Z"), timeMax: new Date("2026-10-23T04:00:00Z"), timezone: "America/Dominica" };
  assert.deepEqual(await checkBusinessCalendarBusy(range, { ...base, loadSelected: async () => null }), { status: "not_selected" });
  assert.equal(executed, 0);
  assert.equal((await checkBusinessCalendarBusy(range, { ...base, loadSelected: async () => ({ calendarId: CAL }) })).status, "ok");
  assert.equal(executed, 1, "positive control: the lookup does run when selected");
  for (const deps of [
    { getConnection: async () => null },
    { getConnection: async () => ({ provider: "outlook" as const, connectedAccountId: "x" }) },
    { executeTool: async () => { throw new Error("503"); } },
  ]) {
    const r = await checkBusinessCalendarBusy(range, { ...base, loadSelected: async () => ({ calendarId: CAL }), ...deps });
    assert.equal(r.status, "unavailable");
  }
});

test("P3: settings unreadable on a tenant -> not_selected (today's behaviour); a caller-held selection still applies", async () => {
  let executed = 0;
  const deps = {
    loadSelected: async () => { throw new Error("db"); },
    getConnection: async () => ({ provider: "googlecalendar" as const, connectedAccountId: "ca_1" }),
    executeTool: async () => { executed += 1; return { successful: true, data: { calendars: { [CAL]: { busy: [] } } } }; },
  };
  const range = { orgId: "o", timeMin: new Date("2026-10-22T04:00:00Z"), timeMax: new Date("2026-10-23T04:00:00Z"), timezone: "America/Dominica" };
  assert.deepEqual(await checkBusinessCalendarBusy(range, deps), { status: "not_selected" });
  assert.equal(executed, 0);
  assert.equal((await checkBusinessCalendarBusy({ ...range, selected: { calendarId: CAL } }, deps)).status, "ok", "twin: a held selection is checked");
  assert.equal((await checkBusinessCalendarBusy({ ...range, selected: null }, deps)).status, "not_selected");
});

test("P2-2: cache serves repeats; per-org rate limit fails CLOSED once exhausted; other orgs unaffected", async () => {
  __resetBusinessCalendarCacheForTests();
  let executed = 0;
  const deps = {
    loadSelected: async () => ({ calendarId: CAL }),
    getConnection: async () => ({ provider: "googlecalendar" as const, connectedAccountId: "ca_1" }),
    executeTool: async () => { executed += 1; return { successful: true, data: { calendars: { [CAL]: { busy: [] } } } }; },
  };
  const day = (i: number) => ({ timeMin: new Date(Date.UTC(2026, 10, 1 + i, 4)), timeMax: new Date(Date.UTC(2026, 10, 2 + i, 4)), timezone: "UTC" });
  assert.equal((await checkBusinessCalendarBusy({ orgId: "o1", ...day(0), useCache: true }, deps)).status, "ok");
  assert.equal((await checkBusinessCalendarBusy({ orgId: "o1", ...day(0), useCache: true }, deps)).status, "ok");
  assert.equal(executed, 1, "repeat served from cache");
  for (let i = 1; i < BUSY_RATE_LIMIT.maxLookups; i++) await checkBusinessCalendarBusy({ orgId: "o1", ...day(i), useCache: true }, deps);
  assert.equal(executed, BUSY_RATE_LIMIT.maxLookups);
  const limited = await checkBusinessCalendarBusy({ orgId: "o1", ...day(99), useCache: true }, deps);
  assert.deepEqual(limited, { status: "unavailable", reason: "rate_limited" }, "fail closed, no provider call");
  assert.equal(executed, BUSY_RATE_LIMIT.maxLookups);
  assert.equal((await checkBusinessCalendarBusy({ orgId: "o1", ...day(0), useCache: true }, deps)).status, "ok", "cached day still served");
  assert.equal((await checkBusinessCalendarBusy({ orgId: "o2", ...day(0), useCache: true }, deps)).status, "ok", "another org is not limited");
  assert.equal((await checkBusinessCalendarBusy({ orgId: "o1", ...day(98), useCache: false }, deps)).status, "ok", "booking-time re-check (no cache) is not rate limited");
});
