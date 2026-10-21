// 2026-10-21 — Selected business calendar: availability (busy) check + gate.
//
// ONE switch for the booking behaviour added on 2026-10-21 (release 1):
// `organizations.settings.bookingCalendar.calendarId`. A workspace WITHOUT a
// selected calendar keeps today's behaviour byte-for-byte (no calendar
// lookup, no new emails). Only a workspace whose operator explicitly selected
// a calendar gets:
//   - public slots filtered by that calendar's busy time (fail CLOSED),
//   - a busy re-check at booking time (uncached),
//   - the calendar-cancellation lifecycle (lib/calendar/booking-lifecycle.ts).
// If the settings themselves cannot be read we cannot know a calendar was
// selected, so TODAY's behaviour applies (callers that already hold the
// settings pass the selection in, so a selected tenant still fails closed).
//
// The calendar is read through the workspace's own Composio googlecalendar
// connection (the /integrations org-level connection, userId = orgId — the
// same resolver calendar-push.ts uses).
//
// Action verified read-only against EPIC's live connection on 2026-10-21:
// GOOGLECALENDAR_FIND_FREE_SLOTS { items: [calendarId], time_min, time_max,
// timezone } → data.calendars[calendarId] = { busy: [{start,end}], free: [...] }
// and, for a calendar it cannot read, { errors: [{domain, reason}], busy: [] }
// with successful=true. Composio documents that an omitted / inaccessible
// calendar reads as FREE — so an `errors` entry or a missing calendar key is
// treated as a lookup FAILURE here, never as "free".
//
// Pure helpers are exported for unit tests; the DB/Composio-bound default
// deps are injectable.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";

export const FIND_FREE_SLOTS_SLUG = "GOOGLECALENDAR_FIND_FREE_SLOTS";

export type SelectedBusinessCalendar = { calendarId: string };

/** Pure: the workspace's explicitly selected business calendar, or null when
 *  none is selected (=> today's behaviour, unchanged). */
export function resolveSelectedBusinessCalendar(
  settings: unknown,
): SelectedBusinessCalendar | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).bookingCalendar;
  if (!raw || typeof raw !== "object") return null;
  const calendarId = (raw as Record<string, unknown>).calendarId;
  if (typeof calendarId !== "string") return null;
  const trimmed = calendarId.trim();
  return trimmed ? { calendarId: trimmed } : null;
}

export async function loadSelectedBusinessCalendar(
  orgId: string,
): Promise<SelectedBusinessCalendar | null> {
  if (!orgId) return null;
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return resolveSelectedBusinessCalendar(row?.settings ?? null);
}

export type BusyWindow = { start: Date; end: Date };

/** Pure: extract the selected calendar's busy windows from a
 *  FIND_FREE_SLOTS response. Anything other than an explicit, error-free
 *  entry for THIS calendar is a failure (fail closed). */
export function parseFreeSlotsBusy(
  res: unknown,
  calendarId: string,
): { ok: true; busy: BusyWindow[] } | { ok: false; reason: string } {
  if (!res || typeof res !== "object") return { ok: false, reason: "no_response" };
  const r = res as Record<string, unknown>;
  if (r.successful === false) return { ok: false, reason: "unsuccessful" };
  let data: unknown = r.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, reason: "unparseable_data" };
    }
  }
  const calendars =
    data && typeof data === "object"
      ? (data as Record<string, unknown>).calendars
      : undefined;
  if (!calendars || typeof calendars !== "object") return { ok: false, reason: "no_calendars" };
  const entry = (calendars as Record<string, unknown>)[calendarId];
  if (!entry || typeof entry !== "object") return { ok: false, reason: "calendar_missing" };
  const e = entry as Record<string, unknown>;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const first = e.errors[0] as Record<string, unknown> | undefined;
    return { ok: false, reason: `calendar_error:${String(first?.reason ?? "unknown")}` };
  }
  if (!Array.isArray(e.busy)) return { ok: false, reason: "no_busy_array" };
  const busy: BusyWindow[] = [];
  for (const w of e.busy) {
    const start = new Date(String((w as Record<string, unknown>)?.start ?? ""));
    const end = new Date(String((w as Record<string, unknown>)?.end ?? ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false, reason: "bad_busy_window" };
    }
    busy.push({ start, end });
  }
  return { ok: true, busy };
}

/** Pure: does [startMs, endMs) overlap any busy window? */
export function overlapsBusy(startMs: number, endMs: number, busy: BusyWindow[]): boolean {
  return busy.some((b) => startMs < b.end.getTime() && endMs > b.start.getTime());
}

/** Pure: drop offered slots (UTC ISO starts) whose [start, start+duration)
 *  overlaps calendar busy time. computeSlotsForDay stays untouched: busy
 *  windows are NOT booked rows (they must not count toward maxBookingsPerDay
 *  nor get the booking buffers). */
export function filterSlotsOutsideBusy(
  slots: string[],
  durationMinutes: number,
  busy: BusyWindow[],
): string[] {
  return slots.filter((iso) => {
    const s = new Date(iso).getTime();
    return !overlapsBusy(s, s + durationMinutes * 60_000, busy);
  });
}

/** Pure: an instant as a naive local "YYYY-MM-DDTHH:MM:SS" in `timezone`
 *  (the format the live probe used with the `timezone` argument). */
export function naiveLocalDateTime(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Pure: the workspace-local calendar date (YYYY-MM-DD) of an instant. */
export function localDateKey(d: Date, timezone: string): string {
  return naiveLocalDateTime(d, timezone).slice(0, 10);
}

export type CalendarConnectionRef = {
  provider: "googlecalendar" | "outlook";
  connectedAccountId: string;
};

export type BusinessCalendarDeps = {
  loadSelected: (orgId: string) => Promise<SelectedBusinessCalendar | null>;
  getConnection: (orgId: string) => Promise<CalendarConnectionRef | null>;
  executeTool: (
    orgId: string,
    connectedAccountId: string,
    slug: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

// ── Short busy-window cache + per-org rate limit (anonymous slot listing) ──
// The public slots route is anonymous; without these, every page view would
// make one provider call. Cached results are only ever SUCCESSFUL lookups; a
// lookup refused by the rate limit with no fresh cache entry fails CLOSED
// (no slots), exactly like any other unavailable lookup. Per-instance memory.
export const BUSY_CACHE_TTL_MS = 60_000;
export const BUSY_RATE_LIMIT = { windowMs: 60_000, maxLookups: 20 };
const BUSY_CACHE_MAX = 500;
const busyCache = new Map<string, { busy: BusyWindow[]; at: number }>();
const lookupLog = new Map<string, number[]>();

export function __resetBusinessCalendarCacheForTests(): void {
  busyCache.clear();
  lookupLog.clear();
}

function rateLimited(orgId: string, nowMs: number): boolean {
  const recent = (lookupLog.get(orgId) ?? []).filter((t) => nowMs - t < BUSY_RATE_LIMIT.windowMs);
  if (recent.length >= BUSY_RATE_LIMIT.maxLookups) {
    lookupLog.set(orgId, recent);
    return true;
  }
  recent.push(nowMs);
  lookupLog.set(orgId, recent);
  return false;
}

export type BusinessCalendarBusyResult =
  | { status: "not_selected" }
  | { status: "ok"; calendarId: string; busy: BusyWindow[] }
  | { status: "unavailable"; reason: string };

/** The workspace's own connected Google calendar account, read through the
 *  same /integrations connection model (listConnections, userId = orgId) the
 *  booking push uses. Throws when the lookup itself fails (callers fail
 *  closed); null when no calendar is connected. */
export async function resolveOrgCalendarConnection(orgId: string): Promise<CalendarConnectionRef | null> {
  const { composioForOrg, listConnections } = await import("@/lib/integrations/composio/client");
  const composio = await composioForOrg(orgId);
  if (!composio) return null;
  const connections = await listConnections(orgId, { client: composio });
  for (const provider of ["googlecalendar", "outlook"] as const) {
    const match = connections.find((c) => c.slug === provider && c.connected && c.connectedAccountId);
    if (match?.connectedAccountId) return { provider, connectedAccountId: match.connectedAccountId };
  }
  return null;
}

async function defaultGetConnection(orgId: string): Promise<CalendarConnectionRef | null> {
  return resolveOrgCalendarConnection(orgId);
}

async function defaultExecuteTool(
  orgId: string,
  connectedAccountId: string,
  slug: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { composioForOrg } = await import("@/lib/integrations/composio/client");
  const composio = await composioForOrg(orgId);
  if (!composio) throw new Error("composio_key_unavailable");
  return composio.tools.execute(slug, {
    userId: orgId,
    connectedAccountId,
    dangerouslySkipVersionCheck: true,
    arguments: args,
  });
}

export const defaultBusinessCalendarDeps: BusinessCalendarDeps = {
  loadSelected: loadSelectedBusinessCalendar,
  getConnection: defaultGetConnection,
  executeTool: defaultExecuteTool,
};

/**
 * Busy windows of the workspace's SELECTED business calendar over
 * [timeMin, timeMax). Never throws.
 *   not_selected → caller keeps today's behaviour (no check at all).
 *   unavailable  → caller must FAIL CLOSED (offer / accept nothing).
 */
export async function checkBusinessCalendarBusy(
  input: {
    orgId: string;
    timeMin: Date;
    timeMax: Date;
    timezone: string;
    /** The selection, when the caller already read the settings (preferred:
     *  no second read, and an unreadable second read can't change the gate). */
    selected?: SelectedBusinessCalendar | null;
    /** Anonymous slot listing: use the short cache + rate limit. The
     *  booking-time re-check passes false (always a fresh lookup). */
    useCache?: boolean;
  },
  deps: BusinessCalendarDeps = defaultBusinessCalendarDeps,
): Promise<BusinessCalendarBusyResult> {
  let selected: SelectedBusinessCalendar | null;
  if (input.selected !== undefined) {
    selected = input.selected;
  } else {
    try {
      selected = await deps.loadSelected(input.orgId);
    } catch {
      // Unreadable settings: we cannot know a calendar was selected, so
      // today's behaviour applies (review P3).
      return { status: "not_selected" };
    }
  }
  if (!selected) return { status: "not_selected" };

  const cacheKey = `${input.orgId}|${selected.calendarId}|${input.timeMin.toISOString()}|${input.timeMax.toISOString()}`;
  const nowMs = Date.now();
  if (input.useCache) {
    const hit = busyCache.get(cacheKey);
    if (hit && nowMs - hit.at < BUSY_CACHE_TTL_MS) {
      return { status: "ok", calendarId: selected.calendarId, busy: hit.busy };
    }
    if (rateLimited(input.orgId, nowMs)) return { status: "unavailable", reason: "rate_limited" };
  }

  try {
    const connection = await deps.getConnection(input.orgId);
    if (!connection) return { status: "unavailable", reason: "no_connection" };
    if (connection.provider !== "googlecalendar") {
      return { status: "unavailable", reason: "provider_unsupported" };
    }
    const res = await deps.executeTool(input.orgId, connection.connectedAccountId, FIND_FREE_SLOTS_SLUG, {
      items: [selected.calendarId],
      time_min: naiveLocalDateTime(input.timeMin, input.timezone),
      time_max: naiveLocalDateTime(input.timeMax, input.timezone),
      timezone: input.timezone,
    });
    const parsed = parseFreeSlotsBusy(res, selected.calendarId);
    if (!parsed.ok) return { status: "unavailable", reason: parsed.reason };
    if (input.useCache) {
      if (busyCache.size >= BUSY_CACHE_MAX) {
        const oldest = busyCache.keys().next().value;
        if (oldest !== undefined) busyCache.delete(oldest);
      }
      busyCache.set(cacheKey, { busy: parsed.busy, at: nowMs });
    }
    return { status: "ok", calendarId: selected.calendarId, busy: parsed.busy };
  } catch (err) {
    return {
      status: "unavailable",
      reason: `lookup_failed:${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    };
  }
}
