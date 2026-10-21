// EPIC 2026-10-21 — Personal Line lifecycle -> the workspace's Default pipeline.
//
// The Uplink side of the signed plsvc -> Uplink link designed in the 2026-10-11 account slice
// (ops/personal-line/specs/subscriber-account-slice-v1.md, pl-journey-events-contract-v1.md). Each event type has
// exactly ONE authoritative source in plsvc (never a notification delivery, never another event):
//
//   type               plsvc source (what the event proves)                                  stage it may advance to
//   pl.signup_started  the signup's own record: lite_provision_attempts row created           Signup started
//   pl.line_created    provisioning success: lite_accounts row created, attempt completed     Line created
//   pl.app_activated   the registration watch observed the line's SIP REGISTER (registeredAt) App activated
//   pl.first_call      an answered CDR with duration > 0, as the existing first-call detector First call
//                      reports it; event time (CDR start) and detection time are SEPARATE facts
//
// NOT here, on purpose: "Paid plan" (stays manual until a trusted Odoo payment_state signal exists — no event type can
// reach it), "Lost" (never automated; a cancelled appointment is not a lost customer), "Lead" (owned by bookings).
//
// Processing (durable, idempotent, native — no parallel CRM, no new scheduler, no second pipeline):
//   1 claim event_id in integration_event_inbox (a redelivery is a no-op 200)
//   2 resolve/attach the contact ONLY through the trusted identity link (link.ts)
//   3 merge facts for the subject
//   4 project ONE deal per subject per workspace into the workspace's DEFAULT pipeline (never created here):
//       no deal yet  -> claim the deal id (CAS on NULL), insert the deal AT the event's stage
//       deal exists  -> forward-only move through lib/deals/stage-move.ts (the kanban path: validation,
//                       compare-and-set, deal.stage_changed attributed to the integration). An older or repeated
//                       event never moves a card back; a card an operator moved further (or to Paid plan / Lost),
//                       or into a stage the pipeline no longer has, is left where it is.
//       stage name missing from the pipeline -> no deal write (the event and facts are still recorded)
//   5 one native activity (timeline entry) per event; 6 emit pl.* on the bus (workflow_event_log)
// Exactly-once effects WITHOUT a transaction (neon-http has none) — Codex r1/r2: every side effect is ONE SQL statement
// that both claims a per-event marker on the inbox row and writes the effect (activity_logged / event_logged), and the
// stage move writes deals.stage and its deal.stage_changed log row in one statement (lib/deals/stage-move.ts). Two
// workers on the same event (a reclaim racing a slow original) can both run; each effect still happens at most once,
// and a crash leaves either both halves of an effect or neither.
// DISPATCH (Codex r3): after a durable log row is written, its in-process dispatch (listeners, wait resume, subscription
// enqueue) is marked on the inbox row (event_dispatched / stage_dispatched). A reclaimed event re-dispatches any of ITS
// logged rows not yet marked — the pl.* row found by its eventId, the deal.stage_changed row by actor.ref = eventId
// (written in the same statement as the move, so it proves this event made that move). Dispatch is therefore
// at-least-once; wait resume (CAS) and subscription enqueue (unique idempotency key) absorb a repeat.
import { randomUUID } from "node:crypto";
import { findStage } from "@/lib/deals/stages";
import type { StageMoveResult } from "@/lib/deals/stage-move";
import type { PipelineStage } from "@/db/schema/pipelines";
import { linkPersonalLine, PL_PROVIDER, type LinkStore } from "./link";
import type { LifecycleConfig } from "./config";
import { verifyIngress } from "./signing";

export const PL_LIFECYCLE_TYPES = ["pl.signup_started", "pl.line_created", "pl.app_activated", "pl.first_call"] as const;
export type PlLifecycleType = (typeof PL_LIFECYCLE_TYPES)[number];

/** The ONLY event -> stage mapping. Rank = pipeline order these events can reach; nothing maps to Paid plan, Lost or Lead. */
export const STAGE_FOR: Readonly<Record<PlLifecycleType, { stage: string; rank: number }>> = Object.freeze({
  "pl.signup_started": { stage: "Signup started", rank: 1 },
  "pl.line_created": { stage: "Line created", rank: 2 },
  "pl.app_activated": { stage: "App activated", rank: 3 },
  "pl.first_call": { stage: "First call", rank: 4 },
});

export type PlLifecycleEvent = {
  eventId: string;
  type: PlLifecycleType;
  tenant: string;
  subjectId: string;
  plAccountId: string | null;
  waId: string | null;
  /** When it happened, if plsvc knows. null = unknown; a detection time is never put here. */
  occurredAt: string | null;
  /** When plsvc observed / recorded it. */
  detectedAt: string;
  facts: Record<string, string | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WA_RE = /^[1-9][0-9]{6,15}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Codex r1 P2: explicitly zoned ISO-8601 instants only (no date-only, no local/naive times).
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_ZONED.test(v) && Number.isFinite(Date.parse(v));
const iso = (v: string) => new Date(v).toISOString();

const FACT_KEYS: Record<PlLifecycleType, readonly string[]> = {
  "pl.signup_started": ["door"],
  "pl.line_created": ["did_masked"],
  "pl.app_activated": ["registered_at", "registration_observed_at", "credential_fetched_at"],
  "pl.first_call": ["first_call_at", "first_call_detected_at"],
};

/** Strict parse: exact keys, typed facts, and the proof field each type's single source establishes. */
export function parseLifecycleEvent(raw: string): PlLifecycleEvent | null {
  if (Buffer.byteLength(raw, "utf8") > 4096) return null;
  // Codex r1 P2: JSON.parse keeps the LAST of duplicated members; a signed body must not be ambiguous. Every key this
  // contract knows is distinct across the envelope and facts, and no accepted value can contain a quote, so a key
  // appearing twice anywhere is a duplicate member.
  if (raw.includes("\\")) return null;   // Codex r2: no accepted value needs an escape; an escaped key could hide a duplicate
  const seen = new Set<string>();
  for (const m of raw.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)) { if (seen.has(m[1])) return null; seen.add(m[1]); }
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = ["event_id", "type", "tenant", "subject_id", "pl_account_id", "wa_id", "occurred_at", "detected_at", "facts"];
  if (Object.keys(o).some((k) => !keys.includes(k)) || keys.some((k) => !(k in o))) return null;
  if (typeof o.event_id !== "string" || !UUID.test(o.event_id)) return null;
  if (typeof o.type !== "string" || !(PL_LIFECYCLE_TYPES as readonly string[]).includes(o.type)) return null;
  const type = o.type as PlLifecycleType;
  if (typeof o.tenant !== "string" || !TENANT_RE.test(o.tenant)) return null;
  if (typeof o.subject_id !== "string" || !ID_RE.test(o.subject_id)) return null;
  if (o.pl_account_id !== null && (typeof o.pl_account_id !== "string" || !ID_RE.test(o.pl_account_id))) return null;
  if (o.wa_id !== null && (typeof o.wa_id !== "string" || !WA_RE.test(o.wa_id))) return null;
  if (o.occurred_at !== null && !isIso(o.occurred_at)) return null;
  if (!isIso(o.detected_at)) return null;
  const f = o.facts as Record<string, unknown>;
  if (typeof f !== "object" || f === null || Array.isArray(f)) return null;
  if (Object.keys(f).some((k) => !FACT_KEYS[type].includes(k))) return null;
  for (const [k, val] of Object.entries(f)) {
    if (val === null) continue;
    if (k === "door") { if (typeof val !== "string" || !/^[a-z_]{1,16}$/.test(val)) return null; continue; }
    if (k === "did_masked") { if (typeof val !== "string" || !/^[+0-9 *]{4,24}$/.test(val)) return null; continue; }
    if (!isIso(val)) return null;
  }
  const occurred = o.occurred_at === null ? null : iso(o.occurred_at as string);
  // per-type proof fields
  if (type !== "pl.signup_started" && o.pl_account_id === null) return null;
  if ((type === "pl.signup_started" || type === "pl.line_created") && occurred === null) return null;
  if (type === "pl.app_activated") {
    // registered_at = the REGISTER's own time when plsvc knows it (listener PeerStatus event), else null;
    // registration_observed_at = when plsvc observed it. The event time is the former or unknown, never the latter.
    if (!isIso(f.registration_observed_at)) return null;
    const regAt = f.registered_at === undefined || f.registered_at === null ? null : iso(f.registered_at as string);
    if (occurred !== regAt) return null;
  }
  if (type === "pl.first_call") {
    if (!isIso(f.first_call_detected_at)) return null;
    const callAt = f.first_call_at === undefined || f.first_call_at === null ? null : iso(f.first_call_at as string);
    // the event time IS the call time, or unknown — never the detection time standing in for it
    if (occurred !== callAt) return null;
  }
  const facts: Record<string, string | null> = {};
  for (const [k, val] of Object.entries(f)) facts[k] = val === null ? null : k === "door" || k === "did_masked" ? (val as string) : iso(val as string);
  return {
    eventId: o.event_id.toLowerCase(), type, tenant: o.tenant, subjectId: o.subject_id,
    plAccountId: (o.pl_account_id as string | null), waId: (o.wa_id as string | null),
    occurredAt: occurred, detectedAt: iso(o.detected_at as string), facts,
  };
}

const SUBJECT: Record<PlLifecycleType, string> = {
  "pl.signup_started": "Personal Line: signup started",
  "pl.line_created": "Personal Line: line created",
  "pl.app_activated": "Personal Line: app activated (SIP registered)",
  "pl.first_call": "Personal Line: first call",
};

export interface LifecycleStore extends LinkStore {
  /** new = claimed now; duplicate = already FINISHED; in_progress = claimed by a worker that has not finished (retryable). */
  claimEvent(orgId: string, e: PlLifecycleEvent, rank: number): Promise<"new" | "duplicate" | "in_progress">;
  finishEvent(orgId: string, eventId: string, applied: boolean, outcome: string): Promise<void>;
  /** Upsert the subject's facts row (merge facts, last_version = greatest). Creates the row the projection claims on. */
  mergeFacts(orgId: string, subjectId: string, rank: number, facts: Record<string, unknown>): Promise<void>;
  defaultPipeline(orgId: string): Promise<{ id: string; stages: PipelineStage[] } | null>;
  readProjection(orgId: string, subjectId: string): Promise<{ dealId: string | null; createdAt: Date | null }>;
  /** CAS: set projected_deal_id iff it is NULL. */
  claimProjection(orgId: string, subjectId: string, dealId: string): Promise<boolean>;
  /** Insert the deal with exactly this id; false if it already exists. */
  insertDeal(orgId: string, d: { id: string; contactId: string; pipelineId: string; title: string; stage: string; probability: number; customFields: Record<string, unknown> }): Promise<boolean>;
  markProjectionCreated(orgId: string, subjectId: string): Promise<void>;
  dealExists(orgId: string, dealId: string): Promise<boolean>;
  /** Record the line's account id on the deal once known (signup started precedes the line). Never overwrites one. */
  attachAccountId(orgId: string, dealId: string, plAccountId: string): Promise<void>;
  /** ONE statement: mark the event's activity as written AND insert it. true = written now; false = already written / no user. */
  addActivityOnce(orgId: string, eventId: string, contactId: string, a: { type: string; subject: string; metadata: Record<string, unknown>; completedAt: Date }): Promise<boolean>;
  /** ONE statement: mark the event's pl.* log row as written AND insert it. Returns the log id, or null if already logged. */
  logEventOnce(orgId: string, eventId: string, type: PlLifecycleType, payload: Record<string, unknown>): Promise<string | null>;
  /** Dispatch bookkeeping (Codex r3). */
  dispatchState(orgId: string, eventId: string): Promise<{ eventDispatched: boolean; stageDispatched: boolean }>;
  markDispatched(orgId: string, eventId: string, which: "event" | "stage"): Promise<void>;
  /** This event's own logged rows: its pl.* row, and the deal.stage_changed row whose actor.ref is this event. */
  findLoggedEvent(orgId: string, type: string, eventId: string): Promise<{ id: string; payload: Record<string, unknown> } | null>;
  findLoggedStageMove(orgId: string, eventId: string): Promise<{ id: string; payload: Record<string, unknown> } | null>;
}

export type MoveFn = (input: { orgId: string; dealId: string; stage: string; actor: { kind: "integration"; name: string; ref?: string | null }; forwardOnly: true }) => Promise<StageMoveResult>;
/** Dispatch an ALREADY-LOGGED event (in-memory listeners, wait resume, subscriptions) — never logs a second row. */
export type Emit = (type: PlLifecycleType | "deal.stage_changed", data: Record<string, unknown>, orgId: string, preLoggedEventId: string) => Promise<void>;

export async function projectDeal(orgId: string, e: PlLifecycleEvent, contactId: string, store: LifecycleStore, move: MoveFn): Promise<string> {
  const target = STAGE_FOR[e.type];
  const pipe = await store.defaultPipeline(orgId);
  if (!pipe) return "no_default_pipeline";
  const t = findStage(pipe.stages, target.stage);
  if (!t) return `stage_missing:${target.stage}`;

  let created = false;
  let proj = await store.readProjection(orgId, e.subjectId);
  const dealRow = (id: string) => ({
    id, contactId, pipelineId: pipe.id,
    title: "Personal Line subscriber",
    stage: t.stage.name,
    probability: Number(t.stage.probability ?? 0),
    customFields: { source: "personal_line", plSubjectId: e.subjectId, ...(e.plAccountId ? { plAccountId: e.plAccountId } : {}) },
  });
  if (!proj.dealId) {
    const id = randomUUID();
    if (await store.claimProjection(orgId, e.subjectId, id)) {
      created = await store.insertDeal(orgId, dealRow(id));
      await store.markProjectionCreated(orgId, e.subjectId);
      proj = { dealId: id, createdAt: new Date() };
    } else {
      proj = await store.readProjection(orgId, e.subjectId);
    }
  }
  if (!proj.dealId) return "projection_unreadable";
  if (!proj.createdAt) {
    // claimed by a concurrent (or crashed) event that has not inserted yet: insert here; either way the move below
    // then brings the card forward to whichever of the two events is further along
    created = (await store.insertDeal(orgId, dealRow(proj.dealId))) || created;
    await store.markProjectionCreated(orgId, e.subjectId);
  } else if (!created && !(await store.dealExists(orgId, proj.dealId))) {
    return "deal_deleted_not_recreated";
  }
  if (e.plAccountId) await store.attachAccountId(orgId, proj.dealId, e.plAccountId);
  const dealId = proj.dealId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await move({ orgId, dealId, stage: target.stage, actor: { kind: "integration", name: PL_PROVIDER, ref: e.eventId }, forwardOnly: true });
    if (r.ok) return `moved:${r.from}->${r.to}`;
    if (r.error === "conflict") continue;
    if (created && r.error === "not_forward") return `deal_created:${t.stage.name}`;
    return `kept:${r.error}${r.from ? `:${r.from}` : ""}`;
  }
  return "kept:conflict";
}

export type ProcessResult =
  | { status: "duplicate" }
  | { status: "in_progress" }
  | { status: "processed"; contactId: string; deal: string; activity: boolean }
  | { status: "failed"; reason: string };

export async function processLifecycleEvent(orgId: string, e: PlLifecycleEvent, store: LifecycleStore, emit: Emit, move: MoveFn): Promise<ProcessResult> {
  const rank = STAGE_FOR[e.type].rank;
  const claim = await store.claimEvent(orgId, e, rank);
  if (claim === "duplicate") return { status: "duplicate" };
  if (claim === "in_progress") return { status: "in_progress" };
  const link = await linkPersonalLine(orgId, { subjectId: e.subjectId, waId: e.waId, displayName: null }, store);
  if (!link.ok) {
    await store.finishEvent(orgId, e.eventId, false, `link_${link.reason}`);
    return { status: "failed", reason: link.reason };
  }
  await store.mergeFacts(orgId, e.subjectId, rank, { ...e.facts, ...(e.plAccountId ? { pl_account_id: e.plAccountId } : {}) });
  const deal = await projectDeal(orgId, e, link.contactId, store, move);
  // the move (if any) dispatched inside moveDealToStage; record that, or re-dispatch THIS event's logged move after a crash
  const ds = await store.dispatchState(orgId, e.eventId);
  if (!ds.stageDispatched) {
    if (!deal.startsWith("moved:")) {
      const prior = await store.findLoggedStageMove(orgId, e.eventId);
      if (prior) await emit("deal.stage_changed", prior.payload, orgId, prior.id);
    }
    await store.markDispatched(orgId, e.eventId, "stage");
  }
  const activity = await store.addActivityOnce(orgId, e.eventId, link.contactId, {
    type: "personal_line",
    subject: SUBJECT[e.type] + (e.occurredAt ? "" : " (time it happened unknown; detection time shown)"),
    metadata: {
      source: "personal_line", event_id: e.eventId, event_type: e.type, occurred_at: e.occurredAt, detected_at: e.detectedAt,
      time_shown: e.occurredAt ? "occurred_at" : "detected_at", pl_account_id: e.plAccountId, facts: e.facts, deal,
    },
    completedAt: new Date(e.occurredAt ?? e.detectedAt),
  });
  const payload = { contactId: link.contactId, subjectId: e.subjectId, plAccountId: e.plAccountId, eventId: e.eventId, occurredAt: e.occurredAt, detectedAt: e.detectedAt, facts: e.facts, deal };
  const logId = await store.logEventOnce(orgId, e.eventId, e.type, payload);
  if (logId) {
    await emit(e.type, payload, orgId, logId);
    await store.markDispatched(orgId, e.eventId, "event");
  } else if (!ds.eventDispatched) {
    const prior = await store.findLoggedEvent(orgId, e.type, e.eventId);   // logged by a worker that crashed before dispatch
    if (prior) await emit(e.type, prior.payload, orgId, prior.id);
    await store.markDispatched(orgId, e.eventId, "event");
  }
  await store.finishEvent(orgId, e.eventId, true, deal);
  return { status: "processed", contactId: link.contactId, deal, activity };
}

// ── the signed webhook (one route: app/api/webhooks/personal-line/[orgId]/route.ts) ───────────────────────────────
export type WebhookDeps = {
  config(): LifecycleConfig | null;
  store(): Promise<LifecycleStore>;
  emit: Emit;
  move: MoveFn;
  nowS?: () => number;
};

export async function handlePersonalLineLifecycle(request: Request, orgId: string, deps: WebhookDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return { status: 400, body: { ok: false, error: "unreadable_body" } };
  const cfg = deps.config();
  if (!cfg) return { status: 503, body: { ok: false, error: "personal_line_not_configured" } };
  const check = verifyIngress(request.headers, raw, cfg.key, (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))());
  if (!check.ok) {
    console.warn(`[pl-lifecycle] refused: ${check.why}`);
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }
  const event = parseLifecycleEvent(raw);
  if (!event) return { status: 422, body: { ok: false, error: "invalid_event" } };
  const mapped = cfg.tenants.get(event.tenant);
  if (!mapped) {
    console.warn(`[pl-lifecycle] refused: unknown tenant`);
    return { status: 403, body: { ok: false, error: "unknown_tenant" } };
  }
  if (mapped !== orgId.toLowerCase()) {
    console.warn(`[pl-lifecycle] refused: tenant/workspace mismatch`);
    return { status: 403, body: { ok: false, error: "tenant_workspace_mismatch" } };
  }
  const result = await processLifecycleEvent(mapped, event, await deps.store(), deps.emit, deps.move);
  console.info(`[pl-lifecycle] ${event.type} ${event.eventId} -> ${result.status}${result.status === "processed" ? ` ${result.deal}` : ""}`);
  if (result.status === "failed") return { status: 409, body: { ok: false, error: result.reason } };
  // Codex r1 P1: an unfinished claim is NOT a success; the sender must retry it later.
  if (result.status === "in_progress") return { status: 503, body: { ok: false, error: "event_in_progress" } };
  return { status: 200, body: { ok: true, ...result } };
}

/** Production store over drizzle (lazy imports keep the parser/handler unit-testable without a database). */
export async function drizzleLifecycleStore(): Promise<LifecycleStore> {
  const { drizzleLinkStore } = await import("./link");
  const { db } = await import("@/db");
  const { activities, deals, organizations, pipelines, integrationEventInbox: inbox, integrationSubjectFacts: facts, users } = await import("@/db/schema");
  const { and, eq, isNull, lt, sql } = await import("drizzle-orm");
  const base = await drizzleLinkStore();
  const P = PL_PROVIDER;
  return {
    ...base,
    async claimEvent(orgId, e, rank) {
      const rows = await db.insert(inbox)
        .values({ orgId, provider: P, eventId: e.eventId, externalId: e.subjectId, type: e.type, occurredAt: e.occurredAt ? new Date(e.occurredAt) : null, detectedAt: new Date(e.detectedAt), version: rank })
        .onConflictDoNothing()
        .returning({ id: inbox.eventId });
      if (rows.length === 1) return "new";
      // A claim whose processing never finished (crash mid-way) is re-claimable after 30 s, atomically, so a sender
      // retry is not told "duplicate" for an event that was never applied. A finished one (outcome set) never is.
      const reclaimed = await db.update(inbox)
        .set({ receivedAt: new Date() })
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, e.eventId), sql`${inbox.outcome} IS NULL`, lt(inbox.receivedAt, new Date(Date.now() - 30_000))))
        .returning({ id: inbox.eventId });
      if (reclaimed.length === 1) return "new";
      const [row] = await db.select({ outcome: inbox.outcome }).from(inbox)
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, e.eventId))).limit(1);
      return row && row.outcome !== null ? "duplicate" : "in_progress";
    },
    async finishEvent(orgId, eventId, applied, outcome) {
      await db.update(inbox).set({ applied, outcome }).where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, eventId)));
    },
    async mergeFacts(orgId, subjectId, rank, f) {
      await db.insert(facts)
        .values({ orgId, provider: P, externalId: subjectId, lastVersion: rank, facts: f })
        .onConflictDoUpdate({
          target: [facts.orgId, facts.provider, facts.externalId],
          set: { facts: sql`${facts.facts} || ${JSON.stringify(f)}::jsonb`, lastVersion: sql`greatest(${facts.lastVersion}, ${rank})`, updatedAt: new Date() },
        });
    },
    async defaultPipeline(orgId) {
      const [p] = await db.select({ id: pipelines.id, stages: pipelines.stages }).from(pipelines)
        .where(and(eq(pipelines.orgId, orgId), eq(pipelines.isDefault, true))).limit(1);
      return p ? { id: p.id, stages: Array.isArray(p.stages) ? p.stages : [] } : null;
    },
    async readProjection(orgId, subjectId) {
      const [r] = await db.select({ dealId: facts.projectedDealId, createdAt: facts.projectedDealCreatedAt }).from(facts)
        .where(and(eq(facts.orgId, orgId), eq(facts.provider, P), eq(facts.externalId, subjectId))).limit(1);
      return { dealId: r?.dealId ?? null, createdAt: r?.createdAt ?? null };
    },
    async claimProjection(orgId, subjectId, dealId) {
      const rows = await db.update(facts).set({ projectedDealId: dealId })
        .where(and(eq(facts.orgId, orgId), eq(facts.provider, P), eq(facts.externalId, subjectId), isNull(facts.projectedDealId)))
        .returning({ id: facts.projectedDealId });
      return rows.length === 1;
    },
    async insertDeal(orgId, d) {
      const rows = await db.insert(deals)
        .values({ id: d.id, orgId, contactId: d.contactId, pipelineId: d.pipelineId, title: d.title, value: "0", stage: d.stage, probability: d.probability, customFields: d.customFields })
        .onConflictDoNothing()
        .returning({ id: deals.id });
      return rows.length === 1;
    },
    async markProjectionCreated(orgId, subjectId) {
      await db.update(facts).set({ projectedDealCreatedAt: new Date() })
        .where(and(eq(facts.orgId, orgId), eq(facts.provider, P), eq(facts.externalId, subjectId), isNull(facts.projectedDealCreatedAt)));
    },
    async dealExists(orgId, dealId) {
      const [r] = await db.select({ id: deals.id }).from(deals).where(and(eq(deals.orgId, orgId), eq(deals.id, dealId))).limit(1);
      return Boolean(r);
    },
    async attachAccountId(orgId, dealId, plAccountId) {
      await db.update(deals)
        .set({ customFields: sql`${deals.customFields} || ${JSON.stringify({ plAccountId })}::jsonb` })
        .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId), sql`NOT (${deals.customFields} ? 'plAccountId')`));
    },
    async addActivityOnce(orgId, eventId, contactId, a) {
      const [org] = await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      let userId = org?.ownerId ?? null;
      if (!userId) {
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);
        userId = u?.id ?? null;
      }
      if (!userId) return false; // activities.user_id is NOT NULL; a workspace with no user gets the bus event only
      const r: any = await db.execute(sql`with c as (
          update integration_event_inbox set activity_logged = true
          where org_id = ${orgId}::uuid and provider = ${P} and event_id = ${eventId} and activity_logged = false returning 1)
        insert into activities (org_id, contact_id, user_id, type, subject, metadata, completed_at)
        select ${orgId}::uuid, ${contactId}::uuid, ${userId}::uuid, ${a.type}, ${a.subject}, ${JSON.stringify(a.metadata)}::jsonb, ${a.completedAt.toISOString()}::timestamptz from c
        returning id`);
      return (r.rows ?? r).length === 1;
    },
    async dispatchState(orgId, eventId) {
      const [r] = await db.select({ e: inbox.eventDispatched, s: inbox.stageDispatched }).from(inbox)
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, eventId))).limit(1);
      return { eventDispatched: !!r?.e, stageDispatched: !!r?.s };
    },
    async markDispatched(orgId, eventId, which) {
      await db.update(inbox).set(which === "event" ? { eventDispatched: true } : { stageDispatched: true })
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, P), eq(inbox.eventId, eventId)));
    },
    async findLoggedEvent(orgId, type, eventId) {
      const r: any = await db.execute(sql`select id, payload from workflow_event_log where org_id = ${orgId}::uuid and event_type = ${type} and payload->>'eventId' = ${eventId} order by emitted_at limit 1`);
      const row = (r.rows ?? r)[0];
      return row ? { id: String(row.id), payload: row.payload } : null;
    },
    async findLoggedStageMove(orgId, eventId) {
      const r: any = await db.execute(sql`select id, payload from workflow_event_log where org_id = ${orgId}::uuid and event_type = 'deal.stage_changed'
        and payload->'actor'->>'kind' = 'integration' and payload->'actor'->>'ref' = ${eventId} order by emitted_at limit 1`);
      const row = (r.rows ?? r)[0];
      return row ? { id: String(row.id), payload: row.payload } : null;
    },
    async logEventOnce(orgId, eventId, type, payload) {
      const r: any = await db.execute(sql`with c as (
          update integration_event_inbox set event_logged = true
          where org_id = ${orgId}::uuid and provider = ${P} and event_id = ${eventId} and event_logged = false returning 1)
        insert into workflow_event_log (org_id, event_type, payload)
        select ${orgId}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb from c
        returning id`);
      const rows = r.rows ?? r;
      return rows.length === 1 ? String(rows[0].id) : null;
    },
  };
}
