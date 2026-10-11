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
import { linkPersonalLine, PL_PROVIDER, type LinkStore } from "./link";
import { verifyIngress, type PlKey } from "./signing";

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
  finishEvent(orgId: string, eventId: string, applied: boolean, outcome: string): Promise<void>;
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
    await store.finishEvent(orgId, e.eventId, false, `link_${link.reason}`);
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
  await store.finishEvent(orgId, e.eventId, true, factsApplied ? "applied" : "stale_facts_kept");
  return { status: "processed", contactId: link.contactId, factsApplied, emitted: emitIt, activity };
}


// ── the signed webhook (one route: app/api/webhooks/personal-line/[orgId]/route.ts) ───────────────────────────────
// Modelled on app/api/webhooks/composio/route.ts (raw body -> HMAC + ±300 s -> parse -> emitSeldonEvent), with the
// secret resolved PER WORKSPACE from that workspace's Personal Line integration (workspace_secrets), never from env.
export type WebhookDeps = {
  resolveEventsKey(orgId: string): Promise<PlKey | null>;
  store(): Promise<EventStore>;
  emit: Emit;
  nowS?: () => number;
};
const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handlePersonalLineWebhook(request: Request, orgId: string, deps: WebhookDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return { status: 400, body: { ok: false, error: "unreadable_body" } };
  // Unconfigured and unknown workspaces answer identically (fail loud, like composio's 503, without an org oracle).
  const key = ORG_UUID.test(orgId) ? await deps.resolveEventsKey(orgId).catch(() => null) : null;
  if (!key) return { status: 503, body: { ok: false, error: "personal_line_not_configured" } };
  const check = verifyIngress(request.headers, raw, key, (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))());
  if (!check.ok) {
    console.warn(`[pl-webhook] refused: ${check.why}`);
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }
  const event = parsePlEvent(raw);
  if (!event) return { status: 422, body: { ok: false, error: "invalid_event" } };
  const result = await processPlEvent(orgId, event, await deps.store(), deps.emit);
  console.info(`[pl-webhook] ${event.type} ${event.eventId} -> ${result.status}`);
  if (result.status === "failed") return { status: 409, body: { ok: false, error: result.reason } };
  return { status: 200, body: { ok: true, ...result } };
}

/** Production store: the link store + generic inbox/facts + native activities over drizzle (lazy imports). */
export async function drizzleEventStore(): Promise<EventStore> {
  const { drizzleLinkStore } = await import("./link");
  const { db } = await import("@/db");
  const { activities, organizations, integrationEventInbox: inbox, integrationSubjectFacts: facts, users } = await import("@/db/schema");
  const { and, eq, lt, sql } = await import("drizzle-orm");
  const base = await drizzleLinkStore();
  const P = PL_PROVIDER;
  return {
    ...base,
    async claimEvent(orgId, e) {
      const rows = await db.insert(inbox)
        .values({ orgId, provider: P, eventId: e.eventId, externalId: e.plAccountId, type: e.type, occurredAt: new Date(e.occurredAt), version: e.version })
        .onConflictDoNothing()
        .returning({ id: inbox.eventId });
      if (rows.length === 1) return true;
      // A claim whose processing never finished (crash mid-way) is re-claimable after 30 s, atomically, so a sender
      // retry is not told "duplicate" for an event that was never applied. A finished one (outcome set) never is.
      const reclaimed = await db.update(inbox)
        .set({ receivedAt: new Date() })
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, e.eventId), sql`${inbox.outcome} IS NULL`, lt(inbox.receivedAt, new Date(Date.now() - 30_000))))
        .returning({ id: inbox.eventId });
      return reclaimed.length === 1;
    },
    async applyFactsIfNewer(orgId, plAccountId, version, f) {
      const inserted = await db.insert(facts)
        .values({ orgId, provider: P, externalId: plAccountId, lastVersion: version, facts: f })
        .onConflictDoNothing()
        .returning({ v: facts.lastVersion });
      if (inserted.length === 1) return true;
      const updated = await db.update(facts)
        .set({ lastVersion: version, facts: sql`${facts.facts} || ${JSON.stringify(f)}::jsonb`, updatedAt: new Date() })
        .where(and(eq(facts.orgId, orgId), eq(facts.provider, P), eq(facts.externalId, plAccountId), lt(facts.lastVersion, version)))
        .returning({ v: facts.lastVersion });
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
    async finishEvent(orgId, eventId, applied, outcome) {
      await db.update(inbox).set({ applied, outcome }).where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, eventId)));
    },
  };
}
