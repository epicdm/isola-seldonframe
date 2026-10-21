import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contacts, deals, pipelines } from "@/db/schema";
import { guardApiRequest } from "@/lib/api/guard";
import { findStage } from "@/lib/deals/stages";

export async function GET(request: Request) {
  const guard = await guardApiRequest(request);
  if ("error" in guard) return guard.error;

  const rows = await db.select().from(deals).where(eq(deals.orgId, guard.orgId));
  return NextResponse.json({ data: rows });
}

export async function POST(request: Request) {
  const guard = await guardApiRequest(request);
  if ("error" in guard) return guard.error;

  const body = await request.json();
  // A contact id is only accepted when it belongs to the caller's workspace.
  if (typeof body.contactId === "string") {
    const [ownContact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, guard.orgId), eq(contacts.id, body.contactId)))
      .limit(1);
    if (!ownContact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.orgId, guard.orgId), eq(pipelines.isDefault, true)))
    .limit(1);

  if (!pipeline) return NextResponse.json({ error: "No pipeline" }, { status: 400 });

  // EPIC 2026-10-21: the stage must be a stage of the pipeline the deal is created in. Omitted = the pipeline's
  // first stage (was the literal "New", which most pipelines — EPIC's included — do not have).
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  let stage: string;
  if (body?.stage !== undefined) {
    if (typeof body.stage !== "string" || !findStage(stages, body.stage)) {
      return NextResponse.json({ error: "unknown_stage", message: `"${String(body.stage)}" is not a stage of the default pipeline.`, stages: stages.map((s) => s.name) }, { status: 422 });
    }
    stage = body.stage;
  } else {
    if (stages.length === 0) return NextResponse.json({ error: "Pipeline has no stages" }, { status: 400 });
    stage = stages[0].name;
  }

  const [row] = await db
    .insert(deals)
    .values({
      orgId: guard.orgId,
      contactId: body.contactId,
      pipelineId: pipeline.id,
      title: body.title,
      value: String(body.value ?? 0),
      stage,
      probability: Number(body.probability ?? 0),
    })
    .returning();

  return NextResponse.json({ data: row }, { status: 201 });
}
