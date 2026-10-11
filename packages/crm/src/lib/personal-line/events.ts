// EPIC 2026-10-11 — Personal Line journey events: the SeldonFrame side of the plsvc -> SeldonFrame source contract
// (ops/personal-line/specs/pl-journey-events-contract-v1.md in Isola-Foundation; design §2 of subscriber-account-slice-v1).
//
// Each event type has exactly ONE valid source in the Personal Line service. This module accepts only these types and
// never infers one from another (an app-link opened is NOT activation; a lead is the native intake form, not a PL event):
//   pl.line_created          explicit confirmed provisioning (provisionLine success)
//   pl.app_activated         first live SIP registration observed (registration now = registered)
//   pl.registration_changed  live registration state changed (registered / not_registered / unknown)
//   pl.first_call            first ANSWERED call in the Magnus CDR
//   pl.plan_purchased        provider-confirmed payment — TYPE DEFINED ONLY: no payment provider exists yet, so nothing
//                            emits it, and nothing here may fake it.
//
// Processing (durable + idempotent, NATIVE projection — no parallel CRM, no new scheduler):
//   1 claim event_id in pl_event_inbox (ON CONFLICT DO NOTHING) — a duplicate is a no-op 200
//   2 resolve/attach the contact ONLY through the trusted identity link (link.ts rules)
//   3 merge facts into pl_account_facts only when version > last_version — an older version never overwrites newer
//   4 one native activity (timeline entry) per event
//   5 emit the event on the existing SeldonFrame bus (emitSeldonEvent -> workflow_event_log + native automations),
//     except a STALE pl.registration_changed, which would announce a state that is no longer current
// Deal pipeline / probability: deliberately NOT touched here (journey is not probability; the forward-only stage move
// is the next slice).
import { linkPersonalLine, type LinkStore } from "./link";

export const PL_EVENT_TYPES = ["pl.line_created", "pl.app_activated", "pl.registration_changed", "pl.first_call", "pl.plan_purchased"] as const;
export type PlEventType = (typeof PL_EVENT_TYPES)[number];

export type PlFacts = {
  plan?: string;
  trial_end?: string;
  registration_now?: "registered" | "not_registered" | "unknown";
  activated_at?: string;
  first_call_at?: string;
  did_masked?: string;
};

export type PlEvent = {
  eventId: string;
  type: PlEventType;
  occurredAt: string;
  version: number;
  plAccountId: string;
  waId: string;
  facts: PlFacts;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WA_RE = /^[1-9][0-9]{6,15}$/;
const isIso = (v: unknown) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const REG = ["registered", "not_registered", "unknown"];

/** Strict parse: exact keys, typed facts, and per-type required facts (so a type cannot arrive without its proof field). */
export function parsePlEvent(raw: string): PlEvent | null {
  if (Buffer.byteLength(raw, "utf8") > 4096) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = ["event_id", "type", "occurred_at", "version", "pl_account_id", "wa_id", "facts"];
  if (Object.keys(o).some((k) => !keys.includes(k))) return null;
  if (typeof o.event_id !== "string" || !UUID.test(o.event_id)) return null;
  if (typeof o.type !== "string" || !(PL_EVENT_TYPES as readonly string[]).includes(o.type)) return null;
  if (!isIso(o.occurred_at)) return null;
  if (typeof o.version !== "number" || !Number.isSafeInteger(o.version) || o.version < 1) return null;
  if (typeof o.pl_account_id !== "string" || !ACCOUNT_RE.test(o.pl_account_id)) return null;
  if (typeof o.wa_id !== "string" || !WA_RE.test(o.wa_id)) return null;
  const f = (o.facts ?? {}) as Record<string, unknown>;
  if (typeof f !== "object" || f === null || Array.isArray(f)) return null;
  const fkeys = ["plan", "trial_end", "registration_now", "activated_at", "first_call_at", "did_masked"];
  if (Object.keys(f).some((k) => !fkeys.includes(k))) return null;
  if (f.plan !== undefined && (typeof f.plan !== "string" || !/^[a-z0-9_]{1,32}$/.test(f.plan))) return null;
  for (const k of ["trial_end", "activated_at", "first_call_at"]) if (f[k] !== undefined && !isIso(f[k])) return null;
  if (f.registration_now !== undefined && !REG.includes(f.registration_now as string)) return null;
  if (f.did_masked !== undefined && (typeof f.did_masked !== "string" || !/^[+0-9 *]{4,24}$/.test(f.did_masked))) return null;
  const type = o.type as PlEventType;
  // proof fields: each type must carry the fact its single source establishes
  if (type === "pl.app_activated" && (f.registration_now !== "registered" || !isIso(f.activated_at))) return null;
  if (type === "pl.registration_changed" && f.registration_now === undefined) return null;
  if (type === "pl.first_call" && !isIso(f.first_call_at)) return null;
  if (type === "pl.plan_purchased" && f.plan === undefined) return null;
  return { eventId: o.event_id, type, occurredAt: new Date(o.occurred_at as string).toISOString(), version: o.version,
    plAccountId: o.pl_account_id, waId: o.wa_id, facts: f as PlFacts };
}

const SUBJECT: Record<PlEventType, string> = {
  "pl.line_created": "Personal Line: line created",
  "pl.app_activated": "Personal Line: app activated",
  "pl.registration_changed": "Personal Line: connection changed",
  "pl.first_call": "Personal Line: first call",
  "pl.plan_purchased": "Personal Line: plan purchased",
};

export interface EventStore extends LinkStore {
  /** true = this event_id is new and now claimed; false = already received (duplicate). */
  claimEvent(orgId: string, e: PlEvent): Promise<boolean>;
  /** Merge facts iff e.version > last_version (or no row). Returns true when applied, false when stale. */
  applyFactsIfNewer(orgId: string, plAccountId: string, version: number, facts: PlFacts): Promise<boolean>;
  addActivity(orgId: string, contactId: string, a: { type: string; subject: string; metadata: Record<string, unknown>; completedAt: Date }): Promise<boolean>;
  finishEvent(eventId: string, applied: boolean, outcome: string): Promise<void>;
}
export type Emit = (type: PlEventType, data: Record<string, unknown>, orgId: string) => Promise<void>;

export type ProcessResult =
  | { status: "duplicate" }
  | { status: "processed"; contactId: string; factsApplied: boolean; emitted: boolean; activity: boolean }
  | { status: "failed"; reason: string };

export async function processPlEvent(orgId: string, e: PlEvent, store: EventStore, emit: Emit): Promise<ProcessResult> {
  if (!(await store.claimEvent(orgId, e))) return { status: "duplicate" };
  const link = await linkPersonalLine(orgId, { plAccountId: e.plAccountId, waId: e.waId, displayName: null }, store);
  if (!link.ok) {
    await store.finishEvent(e.eventId, false, `link_${link.reason}`);
    return { status: "failed", reason: link.reason };
  }
  const factsApplied = await store.applyFactsIfNewer(orgId, e.plAccountId, e.version, e.facts);
  const activity = await store.addActivity(orgId, link.contactId, {
    type: "personal_line",
    subject: SUBJECT[e.type] + (factsApplied ? "" : " (older update; current facts kept)"),
    metadata: { source: "personal_line", event_id: e.eventId, event_type: e.type, version: e.version, occurred_at: e.occurredAt, stale: !factsApplied, facts: e.facts },
    completedAt: new Date(e.occurredAt),
  });
  const emitIt = factsApplied || e.type !== "pl.registration_changed";
  if (emitIt) {
    await emit(e.type, { contactId: link.contactId, plAccountId: e.plAccountId, eventId: e.eventId, occurredAt: e.occurredAt, version: e.version, stale: !factsApplied, facts: e.facts }, orgId);
  }
  await store.finishEvent(e.eventId, true, factsApplied ? "applied" : "stale_facts_kept");
  return { status: "processed", contactId: link.contactId, factsApplied, emitted: emitIt, activity };
}

/** Production store: the link store + inbox/facts/activities over drizzle. Lazy imports keep unit tests DB-free. */
export async function drizzleEventStore(): Promise<EventStore> {
  const { drizzleLinkStore } = await import("./link");
  const { db } = await import("@/db");
  const { activities, organizations, plAccountFacts, plEventInbox, users } = await import("@/db/schema");
  const { and, eq, lt, sql } = await import("drizzle-orm");
  const base = await drizzleLinkStore();
  return {
    ...base,
    async claimEvent(orgId, e) {
      const rows = await db.insert(plEventInbox)
        .values({ eventId: e.eventId, orgId, plAccountId: e.plAccountId, type: e.type, occurredAt: new Date(e.occurredAt), version: e.version })
        .onConflictDoNothing()
        .returning({ id: plEventInbox.eventId });
      if (rows.length === 1) return true;
      // A claim whose processing never finished (crash mid-way) is re-claimable after 30 s, atomically, so a sender
      // retry is not told "duplicate" for an event that was never applied. A finished one (outcome set) never is.
      const reclaimed = await db.update(plEventInbox)
        .set({ receivedAt: new Date() })
        .where(and(eq(plEventInbox.eventId, e.eventId), eq(plEventInbox.orgId, orgId), sql`${plEventInbox.outcome} IS NULL`, lt(plEventInbox.receivedAt, new Date(Date.now() - 30_000))))
        .returning({ id: plEventInbox.eventId });
      return reclaimed.length === 1;
    },
    async applyFactsIfNewer(orgId, plAccountId, version, facts) {
      const inserted = await db.insert(plAccountFacts)
        .values({ orgId, plAccountId, lastVersion: version, facts })
        .onConflictDoNothing()
        .returning({ v: plAccountFacts.lastVersion });
      if (inserted.length === 1) return true;
      const updated = await db.update(plAccountFacts)
        .set({ lastVersion: version, facts: sql`${plAccountFacts.facts} || ${JSON.stringify(facts)}::jsonb`, updatedAt: new Date() })
        .where(and(eq(plAccountFacts.orgId, orgId), eq(plAccountFacts.plAccountId, plAccountId), lt(plAccountFacts.lastVersion, version)))
        .returning({ v: plAccountFacts.lastVersion });
      return updated.length === 1;
    },
    async addActivity(orgId, contactId, a) {
      const [org] = await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      let userId = org?.ownerId ?? null;
      if (!userId) {
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);
        userId = u?.id ?? null;
      }
      if (!userId) return false; // activities.user_id is NOT NULL; a workspace with no user gets the bus event only
      await db.insert(activities).values({ orgId, contactId, userId, type: a.type, subject: a.subject, metadata: a.metadata, completedAt: a.completedAt });
      return true;
    },
    async finishEvent(eventId, applied, outcome) {
      await db.update(plEventInbox).set({ applied, outcome }).where(eq(plEventInbox.eventId, eventId));
    },
  };
}
