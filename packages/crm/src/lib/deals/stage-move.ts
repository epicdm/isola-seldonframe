// EPIC 2026-10-21 — the ONE deal stage-move path.
//
// Before this file, moveDealStageAction (kanban) moved a card and emitted deal.stage_changed, while
// PATCH /api/v1/deals/[id] (the MCP move_deal_stage / update_deal path) wrote ANY string into deals.stage and
// emitted nothing — which is how deal 9e44e2a1 came to sit in "Proposal", a stage its pipeline no longer has,
// with no record of who put it there (ev-laneA-uplink-default-pipeline-stage-automation-audit-2026-10-21).
//
// Every stage move now comes here:
//   - the target stage must be a stage of the DEAL'S OWN pipeline (exact name) — otherwise `unknown_stage`, nothing written
//   - the write is compare-and-set on the stage that was read, so two movers cannot interleave silently (`conflict`)
//   - `forwardOnly` (integrations): the target must sit AFTER the current stage in the pipeline order; a deal whose
//     current stage is not in its pipeline, or that is already at/after the target, is left exactly where it is
//   - the same side effects as the kanban move, in the same order (learning, lifecycle inference, deal.stage_changed,
//     funnel event, brain outcome), with `actor` on the event so an integration move is attributed to the integration
//
// No "use server" here on purpose: this is a server-side function, never an action a browser can call directly.
// Callers authenticate first and pass the orgId they proved.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, deals, organizations, pipelines, type PipelineStage } from "@/db/schema";
import { emitSeldonEvent } from "@/lib/events/bus";
import { inferClientLifecycleFromStatus, recordDealStageLearning } from "@/lib/soul/learning";
import { trackEvent } from "@/lib/analytics/track";
import { logBrainEvent } from "@/lib/analytics/brain";
import { findStage } from "@/lib/deals/stages";

/** The move and its audit row are committed; only the in-process dispatch failed (integration callers only). */
export class StageDispatchError extends Error {
  constructor(public readonly causeError: unknown) { super("deal.stage_changed dispatch failed"); this.name = "StageDispatchError"; }
}

export type StageMoveActor =
  | { kind: "user" }
  | { kind: "api" }
  | { kind: "integration"; name: string; ref?: string | null };

export type StageMoveError = "deal_not_found" | "pipeline_not_found" | "unknown_stage" | "current_stage_unknown" | "not_forward" | "conflict";

export type StageMoveResult =
  | { ok: true; from: string; to: string; probability: number }
  | { ok: false; error: StageMoveError; from?: string; stages?: string[] };

export { findStage };

/** The pipeline a deal belongs to, or null. Scoped by org so a foreign pipeline id never resolves. */
export async function loadDealPipelineStages(orgId: string, pipelineId: string): Promise<PipelineStage[] | null> {
  const [p] = await db
    .select({ stages: pipelines.stages })
    .from(pipelines)
    .where(and(eq(pipelines.orgId, orgId), eq(pipelines.id, pipelineId)))
    .limit(1);
  return p ? (Array.isArray(p.stages) ? p.stages : []) : null;
}

export async function moveDealToStage(input: {
  orgId: string;
  dealId: string;
  stage: string;
  /** Kanban/API callers may pass the probability they show; default = the target stage's configured probability. */
  probability?: number;
  actor: StageMoveActor;
  forwardOnly?: boolean;
}): Promise<StageMoveResult> {
  const { orgId, dealId, stage } = input;
  const [existingDeal] = await db
    .select({ stage: deals.stage, pipelineId: deals.pipelineId })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId)))
    .limit(1);
  if (!existingDeal) return { ok: false, error: "deal_not_found" };

  const stages = await loadDealPipelineStages(orgId, existingDeal.pipelineId);
  if (!stages) return { ok: false, error: "pipeline_not_found", from: existingDeal.stage };
  const target = findStage(stages, stage);
  if (!target) return { ok: false, error: "unknown_stage", from: existingDeal.stage, stages: stages.map((s) => s.name) };

  if (input.forwardOnly) {
    const current = findStage(stages, existingDeal.stage);
    if (!current) return { ok: false, error: "current_stage_unknown", from: existingDeal.stage };
    if (target.index <= current.index) return { ok: false, error: "not_forward", from: existingDeal.stage };
  }

  const probability =
    typeof input.probability === "number" && Number.isFinite(input.probability)
      ? input.probability
      : Number(target.stage.probability ?? 0);

  const actor =
    input.actor.kind === "integration"
      ? { kind: "integration" as const, name: input.actor.name, ref: input.actor.ref ?? null }
      : { kind: input.actor.kind };
  const eventData = { dealId, from: existingDeal.stage, to: stage, actor };
  const closes = probability === 100 || stage.toLowerCase().includes("won") || stage.toLowerCase().includes("lost");
  // ONE statement (Codex r1/r2): the compare-and-set stage write AND its deal.stage_changed audit row commit together,
  // so a crash can never leave a moved card without its event (neon-http has no interactive transactions).
  const moved: any = await db.execute(sql`with moved as (
      update deals set stage = ${stage}, probability = ${probability}, updated_at = now(),
        closed_at = ${closes ? new Date().toISOString() : null}::timestamptz
      where org_id = ${orgId}::uuid and id = ${dealId}::uuid and stage = ${existingDeal.stage}
      returning id)
    insert into workflow_event_log (org_id, event_type, payload)
    select ${orgId}::uuid, 'deal.stage_changed', ${JSON.stringify(eventData)}::jsonb from moved
    returning id`);
  const movedRows = moved.rows ?? moved;
  if (movedRows.length !== 1) return { ok: false, error: "conflict", from: existingDeal.stage };
  const eventLogId = String(movedRows[0].id);

  // ── the kanban move's side effects, unchanged in content and order ─────────────────────────────────────────────
  const [updatedDeal] = await db
    .select({ createdAt: deals.createdAt, value: deals.value, source: contacts.source })
    .from(deals)
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId)))
    .limit(1);

  await recordDealStageLearning({
    orgId,
    stage,
    probability,
    source: updatedDeal?.source ?? undefined,
    value: Number(updatedDeal?.value ?? 0),
    createdAt: updatedDeal?.createdAt ?? undefined,
  });

  await inferClientLifecycleFromStatus({
    orgId,
    status: stage,
    source: updatedDeal?.source ?? undefined,
    lifetimeValue: Number(updatedDeal?.value ?? 0),
  });

  // dispatch the already-logged event (listeners, wait resume, subscriptions) without a second log row
  // an integration retries through its own inbox, so it is told when dispatch failed (the move + audit row stand)
  try {
    await emitSeldonEvent("deal.stage_changed", eventData, { orgId, preLoggedEventId: eventLogId, throwOnDispatchFailure: input.actor.kind === "integration" });
  } catch (err) {
    throw new StageDispatchError(err);
  }

  const dealValue = Number(updatedDeal?.value ?? 0);
  const stageLower = stage.toLowerCase();
  trackEvent(
    "deal_stage_changed",
    {
      deal_id: dealId,
      from_stage: existingDeal.stage,
      to_stage: stage,
      probability,
      deal_value_cents: Math.round(dealValue * 100),
      contact_source: updatedDeal?.source ?? null,
    },
    { orgId },
  );

  void (async () => {
    try {
      const [org] = await db
        .select({ soul: organizations.soul })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const soul = (org?.soul as Record<string, unknown> | null) ?? null;
      const outcome = stageLower.includes("won") ? "won" : stageLower.includes("lost") ? "lost" : "progressed";
      logBrainEvent({
        orgId,
        vertical: typeof soul?.industry === "string" ? (soul.industry as string) : null,
        eventType: "deal_progression",
        context: {
          from_stage: existingDeal.stage,
          to_stage: stage,
          probability,
          deal_value_cents: Math.round(dealValue * 100),
          contact_source: updatedDeal?.source ?? null,
        },
        outcome,
        outcomeValueCents: outcome === "won" ? Math.round(dealValue * 100) : 0,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[brain] deal_progression context fetch failed: ${message}`);
    }
  })();

  return { ok: true, from: existingDeal.stage, to: stage, probability };
}
