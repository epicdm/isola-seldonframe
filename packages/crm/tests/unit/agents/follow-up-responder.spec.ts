// EPIC 2026-10-04 -- follow-ups reach the NAMED responder, never the older placeholder account.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { pickFollowUpOwner, recordOwnedFormFollowUp, type FollowUpStore } from "../../../src/lib/bookings/owned-follow-up";

const PLACEHOLDER = { id: "u-placeholder", email: "owner@placeholder.example.test" }; // oldest
const RESPONDER = { id: "u-responder", email: "Pat.Responder@epic.example.test" };
const USERS = [PLACEHOLDER, RESPONDER];

function fakeStore(responder: string | null) {
  const tasks: Array<{ userId: string; subject: string }> = [];
  const assigned: Array<{ contactId: string | null; userId: string }> = [];
  const store: FollowUpStore = {
    findOwner: async () => {
      const id = pickFollowUpOwner(USERS, responder);
      return id ? { id } : null;
    },
    hasTaskForBooking: async () => false,
    findDealIdForBooking: async () => null,
    insertTask: async (r) => {
      tasks.push({ userId: r.userId, subject: r.subject });
    },
    assignIfEmpty: async (_o, contactId, _d, userId) => {
      assigned.push({ contactId, userId });
    },
  };
  return { store, tasks, assigned };
}
const INPUT = { orgId: "o1", contactId: "c1", formId: "f1", formName: "Get started with Isola", service: "Personal Line", details: null, contactBits: ["Sam Test"] };

describe("pickFollowUpOwner", () => {
  test("a configured responder is chosen even though the placeholder is older, and matching ignores case", () => {
    assert.equal(pickFollowUpOwner(USERS, "pat.responder@EPIC.example.test"), "u-responder");
  });
  test("a configured responder that is not a user yields NO owner (never the placeholder)", () => {
    assert.equal(pickFollowUpOwner(USERS, "nobody@epic.example.test"), null);
  });
  test("positive control: with nothing configured the oldest user is still chosen", () => {
    assert.equal(pickFollowUpOwner(USERS, null), "u-placeholder");
    assert.equal(pickFollowUpOwner(USERS, "  "), "u-placeholder");
    assert.equal(pickFollowUpOwner([], null), null);
  });
});

describe("a form enquiry reaches the named responder", () => {
  test("the task and the empty contact assignment both go to the responder, not the placeholder", async () => {
    const { store, tasks, assigned } = fakeStore("Pat.Responder@epic.example.test");
    const res = await recordOwnedFormFollowUp(store, INPUT);
    assert.deepEqual(res, { recorded: true, assignedTo: "u-responder" });
    assert.deepEqual(tasks.map((t) => t.userId), ["u-responder"]);
    assert.deepEqual(assigned, [{ contactId: "c1", userId: "u-responder" }]);
  });
  test("responder not found: nothing is recorded or assigned (fails closed); the same harness with the responder present records one task", async () => {
    const missing = fakeStore("nobody@epic.example.test");
    assert.deepEqual(await recordOwnedFormFollowUp(missing.store, INPUT), { recorded: false, reason: "no_staff_user" });
    assert.equal(missing.tasks.length, 0);
    assert.equal(missing.assigned.length, 0);
    const present = fakeStore("Pat.Responder@epic.example.test");
    assert.equal((await recordOwnedFormFollowUp(present.store, INPUT)).recorded, true);
    assert.equal(present.tasks.length, 1);
  });
  test("wiring: the real store reads FOLLOW_UP_RESPONDER_EMAIL and goes through pickFollowUpOwner", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/lib/bookings/owned-follow-up.ts"), "utf8");
    assert.match(src, /pickFollowUpOwner\(rows, process\.env\.FOLLOW_UP_RESPONDER_EMAIL\)/);
  });
});
