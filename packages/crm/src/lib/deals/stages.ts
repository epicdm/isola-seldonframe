// EPIC 2026-10-21 — PURE pipeline-stage helpers shared by every stage writer (no database imports).
import type { PipelineStage } from "@/db/schema/pipelines";

/** Exact-name lookup: "lead" is not "Lead", and a stage that was renamed away is gone. */
export function findStage(stages: PipelineStage[] | null | undefined, name: string): { stage: PipelineStage; index: number } | null {
  const list = Array.isArray(stages) ? stages : [];
  const index = list.findIndex((s) => s?.name === name);
  return index < 0 ? null : { stage: list[index], index };
}
