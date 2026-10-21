// EPIC 2026-10-21 — RELEASE 1 path test (Law 20): availability against the
// selected business calendar + the cancellation lifecycle, driven through the
// REAL entry points against a REAL scratch Postgres (production driver,
// DB_DRIVER=pg). Module-mocked boundaries ONLY: the email sender
// (sendEmailFromApi), the Composio SDK (@composio/core — composioForOrg,
// listConnections and secret decryption run for real), Next request APIs,
// session resolvers and the Workflow DevKit start(). Synthetic fixtures.
//
// Every customer email is counted (not only those carrying an .ics) — review
// P2-1: one cancellation email per customer.
//
// Opt-in: BOOKING_LC_DB_TEST=scratch + NEON_LOCAL_HOST + DATABASE_URL (scratch).
// Needs: node --experimental-test-module-mocks --import tsx --test <this file>
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, mock, test } from "node:test";
import { sql } from "drizzle-orm";

const enabled = process.env.BOOKING_LC_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const TZ = "America/Dominica"; // UTC-4, no DST
const ORG_CFG = "d8000000-0000-4000-8000-000000000001"; // selected calendar
const ORG_PLAIN = "d8000000-0000-4000-8000-000000000002"; // no selection (control)
const U_CFG = "d8000000-0000-4000-8000-0000000000a1";
const U_PLAIN = "d8000000-0000-4000-8000-0000000000a2";
const CAL_ID = "meet@calendar.epic.test";
const SLUG = "setup-help";
const RULES = {
  availability: Object.fromEntries(
    ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((d) => [d, { enabled: true, start: "08:00", end: "16:00" }]),
  ),
  minNoticeMinutes: 0,
  maxBookingsPerDay: 16,
  defaultBufferMinutes: 0,
  defaultDurationMinutes: 30,
};

type Sent = { orgId: string; toEmail: string; subject: string; body: string; attachments?: Array<{ filename: string; content: string; contentType?: string }> };
type Call = { slug: string; userId: string; args: Record<string, unknown> };

const sent: Sent[] = [];
const calls: Call[] = [];
const calendarMode: { busy: Array<{ start: string; end: string }>; fail: "none" | "errors" | "throw" } = { busy: [], fail: "none" };
let currentOrg = ORG_CFG;
let portalContactId = "";

class FakeComposio {
  constructor(_o: { apiKey: string }) {}
  private session(id: string) {
    return {
      sessionId: id,
      mcp: { url: `https://mcp.example/${id}`, headers: {} },
      toolkits: async () => ({ items: [{ slug: "googlecalendar", name: "Google Calendar", connection: { isActive: true, connectedAccount: { id: "ca_test_1" } } }] }),
    };
  }
  async create(_u: string) { return this.session("s-new"); }
  async use(id: string) { return this.session(id); }
  tools = {
    execute: async (slug: string, p: { userId: string; arguments: Record<string, unknown> }) => {
      calls.push({ slug, userId: p.userId, args: p.arguments });
      if (slug === "GOOGLECALENDAR_FIND_FREE_SLOTS") {
        if (calendarMode.fail === "throw") throw new Error("composio 503");
        const id = (p.arguments.items as string[])[0];
        if (calendarMode.fail === "errors") return { successful: true, data: { calendars: { [id]: { busy: [], free: [], errors: [{ domain: "global", reason: "notFound" }] } } } };
        return { successful: true, data: { calendars: { [id]: { busy: calendarMode.busy, free: [] } } } };
      }
      return { successful: true, data: { id: "gevt_any" } };
    },
  };
}

function icsOf(s: Sent): string | null {
  const a = s.attachments?.find((x) => (x.contentType ?? "").startsWith("text/calendar"));
  return a ? Buffer.from(a.content, "base64").toString("utf8") : null;
}
const field = (ics: string, k: string) => (ics.match(new RegExp(`^${k}:(.*)$`, "m"))?.[1] ?? "").trim();
function localIso(dateKey: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCHours(h + 4, m, 0, 0);
  return d.toISOString();
}
const futureDateKey = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("release 1: availability + cancellation (scratch Postgres, production driver)", { skip: !enabled && "set BOOKING_LC_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let A: typeof import("@/lib/bookings/actions");
  let P: typeof import("@/lib/customer-portal/appointment-actions");
  // Optional so the SAME spec runs on the base commit (module absent there)
  // and each test reports its own RED.
  let BC: typeof import("@/lib/bookings/business-calendar") | null = null;
  let push: typeof import("@/lib/integrations/calendar-push");
  let sign: (id: string) => string;
  const ex = (q: ReturnType<typeof sql>) => db.execute(q);
  const rows = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
  const DAY = futureDateKey(5);
  let rulesBefore = "";

  before(async () => {
    process.env.BOOKING_MANAGE_SECRET = ["fixture", "manage", "secret"].join("-");
    process.env.AUTH_SECRET = ["fixture", "auth", "secret"].join("-");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const crm = path.resolve(__dirname, "../..");
    const f = (p: string) => pathToFileURL(path.join(crm, p)).href;
    mock.module(f("src/auth.ts"), { namedExports: { auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, handlers: {} } });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });
    mock.module("next/cache", { namedExports: { unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined, revalidatePath: () => undefined } });
    mock.module("workflow/api", { namedExports: { start: async () => ({ runId: "noop" }) } });
    mock.module("@composio/core", { namedExports: { Composio: FakeComposio } });
    mock.module(f("src/lib/emails/api.ts"), {
      namedExports: {
        sendEmailFromApi: async (p: Sent) => {
          sent.push({ orgId: p.orgId, toEmail: p.toEmail, subject: p.subject, body: p.body, attachments: p.attachments });
          return { emailId: `em_${sent.length}`, contactId: null, suppressed: false };
        },
        getEmailWithEvents: async () => null,
      },
    });
    mock.module(f("src/lib/auth/helpers.ts"), {
      namedExports: {
        getOrgId: async () => currentOrg,
        getCurrentUser: async () => ({ id: currentOrg === ORG_CFG ? U_CFG : U_PLAIN, orgId: currentOrg }),
        requireAuth: async () => ({ id: U_CFG }),
        getCurrentWorkspaceRole: async () => "owner",
        userCanAccessOrg: async () => true,
      },
    });
    const portalStub = async () => { throw new Error("not in test"); };
    mock.module(f("src/lib/portal/auth.ts"), {
      namedExports: {
        requestPortalAccessCodeAction: portalStub, verifyPortalAccessCodeAction: portalStub, clearPortalSessionAction: portalStub,
        getPortalSessionForOrg: portalStub, getPortalSessionForToken: portalStub,
        establishPortalMagicSession: portalStub, establishPortalDemoSession: portalStub,
        requirePortalSessionForOrg: async () => ({ orgId: currentOrg, contact: { id: portalContactId } }),
      },
    });

    ({ db } = await import("@/db"));
    const { encryptValue } = await import("@/lib/encryption");
    for (const [org, user, slug, sel] of [[ORG_CFG, U_CFG, "r1-cfg", true], [ORG_PLAIN, U_PLAIN, "r1-plain", false]] as const) {
      const settings = { booking: RULES, ...(sel ? { bookingCalendar: { calendarId: CAL_ID } } : {}) };
      await ex(sql`insert into organizations (id, name, slug, plan, subscription, timezone, settings, owner_id) values (${org}::uuid, ${"R1 " + slug}, ${slug}, 'free', '{}'::jsonb, ${TZ}, ${JSON.stringify(settings)}::jsonb, null)`);
      await ex(sql`insert into users (id, org_id, name, email, role) values (${user}::uuid, ${org}::uuid, 'Owner', ${slug + "-owner@r1.test"}, 'owner')`);
      await ex(sql`update organizations set owner_id = ${user}::uuid where id = ${org}::uuid`);
      await ex(sql`insert into bookings (org_id, title, booking_slug, status, starts_at, ends_at, metadata) values (${org}::uuid, 'Setup help call', ${SLUG}, 'template', now(), now(), ${JSON.stringify({ durationMinutes: 30 })}::jsonb)`);
      // BOTH orgs have a connected calendar: the gate is the explicit
      // selection, not the mere presence of a connection.
      await ex(sql`insert into workspace_secrets (workspace_id, scope, service_name, encrypted_value, key_version, fingerprint) values (${org}::uuid, 'workspace', 'composio', ${encryptValue("ck_fixture_not_a_real_key")}, 1, 'fixture')`);
    }
    rulesBefore = JSON.stringify((await rows<{ b: unknown }>(sql`select settings->'booking' as b from organizations where id=${ORG_CFG}::uuid`))[0].b);

    A = await import("@/lib/bookings/actions");
    P = await import("@/lib/customer-portal/appointment-actions");
    BC = await import("@/lib/bookings/business-calendar").catch(() => null);
    push = await import("@/lib/integrations/calendar-push");
    sign = (await import("@/lib/bookings/manage-token")).signBookingManageToken;
  });

  after(async () => {
    const g = globalThis as { __sfPgPool?: { end: () => Promise<void> } };
    await g.__sfPgPool?.end().catch(() => undefined);
  });

  const reset = () => { sent.length = 0; calls.length = 0; push.__resetCalendarPushMemoForTests(); BC?.__resetBusinessCalendarCacheForTests(); };
  const freeSlotCalls = (org: string) => calls.filter((c) => c.slug === "GOOGLECALENDAR_FIND_FREE_SLOTS" && c.userId === org);
  const book = async (orgSlug: string, email: string, hhmm: string, day = DAY) => {
    await A.submitPublicBookingAction({ orgSlug, bookingSlug: SLUG, fullName: "Pat Customer", email, startsAt: localIso(day, hhmm) });
    const [b] = await rows<{ id: string; contact_id: string }>(sql`select id, contact_id from bookings where email=${email} and status='scheduled'`);
    return b;
  };

  test("slots: busy time removes slots on the selected calendar; the unselected tenant is unchanged (control)", async () => {
    reset();
    calendarMode.fail = "none";
    calendarMode.busy = [{ start: localIso(DAY, "09:00"), end: localIso(DAY, "10:00") }];
    const cfg = await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: DAY });
    const plain = await A.listPublicBookingSlotsAction({ orgSlug: "r1-plain", bookingSlug: SLUG, date: DAY });
    assert.ok(plain.slots.includes(localIso(DAY, "09:00")), "control: 09:00 is an approved slot when no calendar is checked");
    assert.ok(!cfg.slots.includes(localIso(DAY, "09:00")) && !cfg.slots.includes(localIso(DAY, "09:30")));
    assert.equal(plain.slots.length - cfg.slots.length, 2, "exactly the two busy half-hours removed");
    assert.deepEqual(freeSlotCalls(ORG_CFG)[0].args.items, [CAL_ID], "the SELECTED calendar is queried");
    assert.equal(freeSlotCalls(ORG_PLAIN).length, 0, "no calendar lookup for the unselected tenant");
  });

  test("slots: repeated anonymous requests for the same org/day hit the cache (one provider call) — review P2-2", async () => {
    reset();
    calendarMode.busy = [];
    for (let i = 0; i < 5; i++) await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: DAY });
    assert.equal(freeSlotCalls(ORG_CFG).length, 1, "5 page views, 1 lookup");
    await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: futureDateKey(6) });
    assert.equal(freeSlotCalls(ORG_CFG).length, 2, "control: another day is a new lookup");
  });

  test("slots: lookup failure FAILS CLOSED with an honest flag; failures are not cached; control unaffected", async () => {
    for (const mode of ["errors", "throw"] as const) {
      reset();
      calendarMode.fail = mode;
      const cfg = await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: DAY });
      const plain = await A.listPublicBookingSlotsAction({ orgSlug: "r1-plain", bookingSlug: SLUG, date: DAY });
      assert.deepEqual(cfg.slots, [], `${mode}: no unchecked slots`);
      assert.equal((cfg as { availabilityUnavailable?: boolean }).availabilityUnavailable, true);
      assert.ok(plain.slots.length > 0, `${mode}: control tenant still offers slots`);
    }
    calendarMode.fail = "none";
    const again = await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: DAY });
    assert.ok(again.slots.length > 0, "a failure is not cached: the next request recovers");
  });

  test("submit: fresh busy re-check refuses a stale slot and refuses on lookup failure (the cache is not used)", async () => {
    reset();
    calendarMode.busy = [];
    await A.listPublicBookingSlotsAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, date: DAY }); // warms the cache: 11:00 free
    calendarMode.busy = [{ start: localIso(DAY, "11:00"), end: localIso(DAY, "11:30") }];
    await assert.rejects(
      A.submitPublicBookingAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, fullName: "Stale", email: "stale@r1.test", startsAt: localIso(DAY, "11:00") }),
      /slot_calendar_busy/,
    );
    calendarMode.busy = [];
    calendarMode.fail = "errors";
    await assert.rejects(
      A.submitPublicBookingAction({ orgSlug: "r1-cfg", bookingSlug: SLUG, fullName: "Down", email: "down@r1.test", startsAt: localIso(DAY, "11:00") }),
      /calendar_availability_unavailable/,
    );
    calendarMode.fail = "none";
    const n = await rows<{ n: number }>(sql`select count(*)::int as n from bookings where org_id=${ORG_CFG}::uuid and status <> 'template'`);
    assert.equal(n[0].n, 0, "neither refused submit created a booking");
  });

  test("cancel via the PUBLIC MANAGEMENT LINK: ONE customer email (the existing one) carrying the CANCEL; organizer notice; CRM appended; reminder cancelled; exactly once", async () => {
    reset();
    const b = await book("r1-cfg", "pat@r1.test", "10:00");
    const invite = sent.find((s) => s.toEmail === "pat@r1.test" && icsOf(s));
    assert.ok(invite, "invite sent at creation (unchanged)");
    assert.equal(field(icsOf(invite!)!, "SEQUENCE"), "0");
    const booked = JSON.stringify(await rows(sql`select id, type, subject, body, metadata from activities where metadata->>'bookingId'=${b.id} and type='meeting'`));
    assert.ok(booked.includes("Booked"));
    const pendingBefore = await rows<{ n: number }>(sql`select count(*)::int as n from outbound_scheduled_sends where status='pending' and payload->>'bookingId'=${b.id}`);
    assert.equal(pendingBefore[0].n, 1, "a 24h reminder was pending");

    reset();
    assert.deepEqual(await A.cancelBookingByTokenAction({ bookingId: b.id, token: sign(b.id) }), { ok: true, alreadyCancelled: false });
    const customer = sent.filter((s) => s.toEmail === "pat@r1.test");
    assert.equal(customer.length, 1, "ONE customer email for the cancellation (review P2-1)");
    const ics = icsOf(customer[0]);
    assert.ok(ics, "the existing cancellation email carries the calendar CANCEL");
    assert.doesNotMatch(customer[0].subject, /^Cancelled: /, "it is the existing cancellation email, not the fallback");
    assert.equal(field(ics!, "METHOD"), "CANCEL");
    assert.equal(field(ics!, "STATUS"), "CANCELLED");
    assert.equal(field(ics!, "UID"), `booking-${b.id}@seldonframe.com`);
    assert.equal(field(ics!, "SEQUENCE"), "1", "above the invite's 0");
    const owner = sent.filter((s) => s.toEmail === "r1-cfg-owner@r1.test");
    assert.equal(owner.length, 1, "one organizer notice");
    assert.match(owner[0].subject, /^Booking cancelled/);
    assert.equal(field(icsOf(owner[0])!, "UID"), `booking-${b.id}@seldonframe.com`);
    assert.match(owner[0].body, /not removed automatically yet/, "honest about the connected-calendar copy");
    const pend = await rows<{ n: number }>(sql`select count(*)::int as n from outbound_scheduled_sends where status='pending' and payload->>'bookingId'=${b.id}`);
    assert.equal(pend[0].n, 0, "reminder cancelled");
    const act = await rows<{ n: number }>(sql`select count(*)::int as n from activities where type='booking_cancelled' and metadata->>'bookingId'=${b.id} and metadata->>'source'='booking_manage_link'`);
    assert.equal(act[0].n, 1, "cancellation outcome appended");
    assert.equal(JSON.stringify(await rows(sql`select id, type, subject, body, metadata from activities where metadata->>'bookingId'=${b.id} and type='meeting'`)), booked, "original activity unchanged");

    reset();
    assert.deepEqual(await A.cancelBookingByTokenAction({ bookingId: b.id, token: sign(b.id) }), { ok: true, alreadyCancelled: true });
    const { emitSeldonEvent } = await import("@/lib/events/bus");
    await emitSeldonEvent("booking.cancelled", { appointmentId: b.id, contactId: b.contact_id }, { orgId: ORG_CFG });
    assert.equal(sent.length, 0, "a repeated cancel (click or event) sends nothing at all");
  });

  test("cancellation trigger disabled: the CANCEL goes on a dedicated email instead — still exactly one", async () => {
    reset();
    const b = await book("r1-cfg", "alt@r1.test", "12:00");
    await ex(sql`update outbound_message_triggers set enabled=false where org_id=${ORG_CFG}::uuid and skill_id='booking-cancellation'`);
    reset();
    await A.cancelBookingByTokenAction({ bookingId: b.id, token: sign(b.id) });
    const customer = sent.filter((s) => s.toEmail === "alt@r1.test");
    assert.equal(customer.length, 1);
    assert.match(customer[0].subject, /^Cancelled: /, "fallback dedicated email");
    assert.equal(field(icsOf(customer[0])!, "METHOD"), "CANCEL");
    await ex(sql`update outbound_message_triggers set enabled=true where org_id=${ORG_CFG}::uuid and skill_id='booking-cancellation'`);
  });

  test("cancel via the CUSTOMER PORTAL: ONE customer email carrying the CANCEL, reminder cancelled; a repeat sends nothing", async () => {
    reset();
    const b = await book("r1-cfg", "portal@r1.test", "13:00");
    portalContactId = b.contact_id;
    currentOrg = ORG_CFG;
    reset();
    assert.deepEqual(await P.cancelBookingAction({ orgSlug: "r1-cfg", bookingId: b.id }), { ok: true, bookingId: b.id });
    const customer = sent.filter((s) => s.toEmail === "portal@r1.test");
    assert.equal(customer.length, 1, "one customer email");
    assert.equal(field(icsOf(customer[0])!, "METHOD"), "CANCEL");
    const pend = await rows<{ n: number }>(sql`select count(*)::int as n from outbound_scheduled_sends where status='pending' and payload->>'bookingId'=${b.id}`);
    assert.equal(pend[0].n, 0, "the portal cancel now cancels the reminder");
    reset();
    await P.cancelBookingAction({ orgSlug: "r1-cfg", bookingId: b.id });
    assert.equal(sent.length, 0, "repeat portal cancel sends nothing");
  });

  test("CONTROL tenant (no selected calendar): today's behaviour — no calendar check, existing cancellation email without .ics, no organizer notice, no new CRM row", async () => {
    reset();
    calendarMode.busy = [{ start: localIso(DAY, "09:00"), end: localIso(DAY, "10:00") }];
    const b = await book("r1-plain", "kim@r1.test", "09:00");
    assert.ok(b, "busy calendar time is NOT checked for the control tenant");
    const owner = sent.find((s) => s.toEmail === "r1-plain-owner@r1.test" && s.subject.startsWith("New booking"));
    assert.ok(owner && icsOf(owner), "owner invite .ics unchanged");
    assert.equal(freeSlotCalls(ORG_PLAIN).length, 0);
    reset();
    assert.deepEqual(await A.cancelBookingByTokenAction({ bookingId: b.id, token: sign(b.id) }), { ok: true, alreadyCancelled: false });
    const customer = sent.filter((s) => s.toEmail === "kim@r1.test");
    assert.equal(customer.length, 1, "the existing cancellation email");
    assert.equal(icsOf(customer[0]), null, "unchanged: no .ics");
    assert.equal(sent.filter((s) => s.toEmail === "r1-plain-owner@r1.test").length, 0, "no organizer notice (unchanged)");
    const act = await rows<{ n: number }>(sql`select count(*)::int as n from activities where org_id=${ORG_PLAIN}::uuid and type='booking_cancelled'`);
    assert.equal(act[0].n, 0, "no new CRM row (unchanged)");
  });

  test("approved hours are byte-identical after every operation (incl. saving the calendar selection)", async () => {
    currentOrg = ORG_CFG;
    assert.deepEqual(await A.updateBookingCalendarAction({ calendarId: CAL_ID }), { ok: true, calendarId: CAL_ID });
    assert.deepEqual(await A.updateBookingCalendarAction({ calendarId: "bad id<>" }), { ok: false, error: "invalid_calendar_id" });
    const after = JSON.stringify((await rows<{ b: unknown }>(sql`select settings->'booking' as b from organizations where id=${ORG_CFG}::uuid`))[0].b);
    assert.equal(after, rulesBefore);
    assert.deepEqual(await A.getBookingCalendarSelectionAction(), { calendarId: CAL_ID });
  });
});
