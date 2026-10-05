// EPIC 2026-10-04 -- a form enquiry leaves one OWNED follow-up task (positive twins included).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { recordOwnedFormFollowUp, type FollowUpStore } from "../../../src/lib/bookings/owned-follow-up";

function store(opts: { owner?: string | null; failInsert?: boolean }) {
  const inserted: Array<Record<string, unknown>> = [];
  const assigned: unknown[][] = [];
  const s: FollowUpStore = {
    findOwner: async () => (opts.owner === null ? null : { id: opts.owner ?? "staff-1" }),
    hasTaskForBooking: async () => false,
    findDealIdForBooking: async () => null,
    insertTask: async (row) => {
      if (opts.failInsert) throw new Error("db down");
      inserted.push(row as unknown as Record<string, unknown>);
    },
    assignIfEmpty: async (...a) => {
      assigned.push(a);
    },
  };
  return { s, inserted, assigned };
}
const IN = {
  orgId: "org-1",
  contactId: "contact-1",
  formId: "form-1",
  formName: "Get started with Isola",
  service: "Personal Line - a Dominica phone number set up on WhatsApp",
  details: "I want a line",
  contactBits: ["Pat Lee", "pat@example.invalid", "+1 767 555 0100"],
};

describe("recordOwnedFormFollowUp", () => {
  test("a Personal Line enquiry creates ONE task for staff, says nothing was activated or charged, and assigns the contact", async () => {
    const { s, inserted, assigned } = store({});
    assert.deepEqual(await recordOwnedFormFollowUp(s, IN), { recorded: true, assignedTo: "staff-1" });
    assert.equal(inserted.length, 1);
    const row = inserted[0] as { subject: string; userId: string; contactId: string; body: string };
    assert.equal(row.subject, "Personal Line activation follow-up");
    assert.equal(row.userId, "staff-1");
    assert.equal(row.contactId, "contact-1");
    assert.match(row.body, /Nothing has been activated or charged/);
    assert.match(row.body, /\+1 767 555 0100/);
    assert.deepEqual(assigned[0], ["org-1", "contact-1", null, "staff-1"]);
  });
  test("control: another service gets the generic subject", async () => {
    const { s, inserted } = store({});
    await recordOwnedFormFollowUp(s, { ...IN, service: "AI upgrade for an existing EPIC phone line" });
    assert.equal((inserted[0] as { subject: string }).subject, "Enquiry follow-up");
  });
  test("no staff user -> nothing recorded; store failure -> reported, never thrown", async () => {
    const none = store({ owner: null });
    assert.deepEqual(await recordOwnedFormFollowUp(none.s, IN), { recorded: false, reason: "no_staff_user" });
    assert.equal(none.inserted.length, 0);
    assert.deepEqual(await recordOwnedFormFollowUp(store({ failInsert: true }).s, IN), { recorded: false, reason: "store_error" });
  });
});

describe("wiring: public intake route", () => {
  test("records the follow-up right after the submission is stored and never blocks the response", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/app/api/v1/public/intake/route.ts"), "utf8");
    const insert = src.indexOf("await db.insert(intakeSubmissions)");
    const fu = src.indexOf("recordOwnedFormFollowUp(drizzleFollowUpStore()");
    const bridge = src.indexOf("Documents bridge. When the submission");
    assert.ok(insert > 0 && fu > insert && fu < bridge, "follow-up sits between the submission insert and the documents bridge");
    assert.match(src.slice(fu - 200, fu + 1400), /catch \(fuErr\)/);
  });
});
