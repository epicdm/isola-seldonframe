"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contacts, deals, pipelines, type PipelineStage } from "@/db/schema";
import { getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";
import { recordDealStageLearning } from "@/lib/soul/learning";
import { ensureDefaultPipelineForOrg } from "@/lib/deals/pipeline-defaults";
import { moveDealToStage } from "@/lib/deals/stage-move";

export async function listDeals(orgIdOverride?: string) {
  // v1.24.0 — accept orgId override for operator-portal mirror.
  const orgId = orgIdOverride ?? (await getOrgId());

  if (!orgId) {
    return [];
  }

  return db.select().from(deals).where(eq(deals.orgId, orgId));
}

export async function getDefaultPipeline(orgIdOverride?: string) {
  // v1.24.0 — accept orgId override for operator-portal mirror.
  const orgId = orgIdOverride ?? (await getOrgId());

  if (!orgId) {
    return null;
  }

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.orgId, orgId), eq(pipelines.isDefault, true)))
    .limit(1);

  return pipeline ?? null;
}

/**
 * 2026-05-17 — save edits to the default pipeline's stages.
 * Operators rename stages, drop unused ones, or reorder them via
 * /settings/pipeline. Stages persist as a JSONB array on the
 * pipelines row.
 *
 * Validates: each stage must have a non-empty name. Empty arrays
 * are rejected — every workspace needs at least one stage.
 */
export async function saveDefaultPipelineStagesAction(input: {
  stages: PipelineStage[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  assertWritable();
  const orgId = await getOrgId();
  if (!orgId) return { ok: false, error: "unauthorized" };

  const stages = (input.stages ?? [])
    .map((s) => ({
      name: String(s.name ?? "").trim(),
      color: String(s.color ?? "#9ca3af"),
      probability: Math.max(0, Math.min(100, Number(s.probability ?? 0))),
    }))
    .filter((s) => s.name.length > 0);

  if (stages.length === 0) {
    return { ok: false, error: "at_least_one_stage_required" };
  }

  await db
    .update(pipelines)
    .set({ stages, updatedAt: new Date() })
    .where(and(eq(pipelines.orgId, orgId), eq(pipelines.isDefault, true)));

  revalidatePath("/settings/pipeline");
  revalidatePath("/settings");
  revalidatePath("/deals");
  return { ok: true };
}

export async function createDealAction(formData: FormData) {
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  // Self-heal: workspaces created via the MCP `create_workspace` tool
  // before pipeline-seeding was wired into `createAnonymousWorkspace`
  // have no `pipelines` row. Without this, the very first deal-create
  // form submission lands the page in the global error boundary
  // ("Pipeline not configured"). ensureDefaultPipelineForOrg returns
  // the existing pipeline if there is one, otherwise inserts a
  // standard B2B funnel (Lead → Qualified → ... → Won/Lost).
  const pipeline = await ensureDefaultPipelineForOrg(orgId);

  const contactId = String(formData.get("contactId") ?? "");

  if (!contactId) {
    throw new Error("Contact required");
  }

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
    .limit(1);

  if (!contact) {
    throw new Error("Contact not found");
  }

  const firstStage = Array.isArray(pipeline.stages) && pipeline.stages.length > 0 ? pipeline.stages[0] : { name: "New", probability: 0 };

  await db.insert(deals).values({
    orgId,
    contactId: contact.id,
    pipelineId: pipeline.id,
    title: String(formData.get("title") ?? "Untitled"),
    stage: String((firstStage as { name?: string }).name ?? "New"),
    probability: Number((firstStage as { probability?: number }).probability ?? 0),
    value: String(formData.get("value") ?? "0"),
  });

  await recordDealStageLearning({
    orgId,
    stage: String((firstStage as { name?: string }).name ?? "New"),
    probability: Number((firstStage as { probability?: number }).probability ?? 0),
    source: contact.source,
    value: Number(formData.get("value") ?? 0),
    createdAt: new Date(),
  });
}

/**
 * Quick-add variant of `createDealAction` — accepts a structured
 * argument instead of FormData and returns a typed result instead of
 * throwing. Used by the kanban "+ Add deal" inline form so a missing
 * contact (or other validation failure) renders as an inline error
 * rather than triggering the global error boundary.
 *
 * On success, inserts the deal at the chosen stage (default: first
 * stage of the org's default pipeline, auto-seeded if missing).
 */
export async function quickCreateDealAction(input: {
  title: string;
  contactId: string;
  value: number;
  stage?: string;
}): Promise<
  | { ok: true; dealId: string; stage: string; probability: number }
  | { ok: false; error: string }
> {
  assertWritable();

  const orgId = await getOrgId();
  if (!orgId) return { ok: false, error: "Unauthorized." };

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Deal title is required." };
  if (title.length > 200) return { ok: false, error: "Title must be 200 chars or fewer." };

  if (!input.contactId) return { ok: false, error: "Pick a contact." };

  const value = Number.isFinite(input.value) && input.value >= 0 ? input.value : 0;

  const pipeline = await ensureDefaultPipelineForOrg(orgId);

  const [contact] = await db
    .select({ id: contacts.id, source: contacts.source })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, input.contactId)))
    .limit(1);

  if (!contact) return { ok: false, error: "Contact not found." };

  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  const fallbackStage = stages[0] ?? { name: "New", probability: 0 };
  // EPIC 2026-10-21: a named stage must exist in this pipeline — refused, never silently replaced by the first stage.
  const namedStage = input.stage ? stages.find((s) => s.name === input.stage) : undefined;
  if (input.stage && !namedStage) return { ok: false, error: "Unknown stage." };
  const targetStage = namedStage ?? fallbackStage;

  const [created] = await db
    .insert(deals)
    .values({
      orgId,
      contactId: contact.id,
      pipelineId: pipeline.id,
      title,
      value: String(value),
      stage: targetStage.name,
      probability: targetStage.probability ?? 0,
    })
    .returning({ id: deals.id });

  if (!created) return { ok: false, error: "Could not create deal." };

  await recordDealStageLearning({
    orgId,
    stage: targetStage.name,
    probability: targetStage.probability ?? 0,
    source: contact.source,
    value,
    createdAt: new Date(),
  }).catch(() => undefined);

  return {
    ok: true,
    dealId: created.id,
    stage: targetStage.name,
    probability: targetStage.probability ?? 0,
  };
}

/**
 * Kanban drag/drop. EPIC 2026-10-21: the body moved to lib/deals/stage-move.ts so the REST API, the MCP tools and
 * the Personal Line integration go through exactly this path (validation against the deal's pipeline,
 * compare-and-set, deal.stage_changed with the actor). Same side effects as before.
 */
export async function moveDealStageAction(dealId: string, stage: string, probability: number) {
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const result = await moveDealToStage({ orgId, dealId, stage, probability, actor: { kind: "user" } });
  if (!result.ok) {
    if (result.error === "deal_not_found") throw new Error("Deal not found");
    if (result.error === "unknown_stage") throw new Error("Unknown stage");
    if (result.error === "conflict") throw new Error("Deal changed, refresh and try again");
    throw new Error("Could not move deal");
  }
}
