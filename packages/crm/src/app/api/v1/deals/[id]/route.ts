import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { deals } from "@/db/schema";
import { guardApiRequest } from "@/lib/api/guard";
import { moveDealToStage } from "@/lib/deals/stage-move";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const [row] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.orgId, guard.orgId), eq(deals.id, id)))
    .limit(1);

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data: row });
}

// EPIC 2026-10-21: a stage change through this route (MCP move_deal_stage / update_deal) goes through the same
// path as the kanban move (lib/deals/stage-move.ts): the stage must exist in the deal's pipeline, and the move emits
// deal.stage_changed attributed to the API caller. An unknown stage is refused with 422 and NOTHING is written —
// the title/value of the same request are not applied either. A request without `stage` behaves exactly as before.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request);
  if ("error" in guard) return guard.error;

  const body = await request.json();
  const { id } = await params;

  if (body?.stage !== undefined) {
    if (typeof body.stage !== "string" || body.stage.trim() === "") {
      return NextResponse.json({ error: "stage must be a non-empty string" }, { status: 422 });
    }
    const moved = await moveDealToStage({
      orgId: guard.orgId,
      dealId: id,
      stage: body.stage,
      probability: typeof body.probability === "number" ? body.probability : undefined,
      actor: { kind: "api" },
    });
    if (!moved.ok) {
      if (moved.error === "deal_not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (moved.error === "unknown_stage") {
        return NextResponse.json({ error: "unknown_stage", message: `"${body.stage}" is not a stage of this deal's pipeline.`, stages: moved.stages ?? [] }, { status: 422 });
      }
      if (moved.error === "conflict") return NextResponse.json({ error: "conflict", message: "The deal changed while moving; retry." }, { status: 409 });
      return NextResponse.json({ error: moved.error }, { status: 422 });
    }
  }

  const [row] = await db
    .update(deals)
    .set({
      title: body.title,
      // stage + probability already applied by the move above; without a stage, probability is applied as before
      probability: body?.stage !== undefined ? undefined : body.probability,
      value: body.value ? String(body.value) : undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(deals.orgId, guard.orgId), eq(deals.id, id)))
    .returning();

  return NextResponse.json({ data: row });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiRequest(request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  await db.delete(deals).where(and(eq(deals.orgId, guard.orgId), eq(deals.id, id)));
  return NextResponse.json({ success: true });
}
