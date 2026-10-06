"use server";

// "Make it fit anybody" — the org-scoped server actions for the propose→apply
// template generalization flow (Task 2). Thin wiring over the pure core
// (generalize.ts) + the DI'd tx orchestrator (apply-generalization-tx.ts):
// auth + org-guard + the real db.transaction that rewrites the template's
// blueprint and back-fills the author's own existing deployments' persona
// customization in one atomic unit.

import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { agentTemplates } from "@/db/schema/agent-templates";
import { deployments } from "@/db/schema/deployments";
import type { AgentBlueprint } from "@/db/schema/agents";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";
import {
  proposeTemplateGeneralization,
  type ProposedSubstitution,
  type AcceptedGeneralizationRow,
  type GeneralizationLlm,
} from "./generalize";
import { makeGeneralizationLlm, DEFAULT_GENERALIZATION_MODEL } from "./generalize-llm";
import { buildGeneralizeFailureLog } from "./generalize-log";
import {
  applyTemplateGeneralizationTx,
  type ApplyGeneralizationTxResult,
} from "./apply-generalization-tx";

async function requireOrgAndUser(): Promise<{ orgId: string } | { error: "unauthorized" }> {
  const orgId = await getOrgId();
  const user = await getCurrentUser();
  if (!user?.id || !orgId) return { error: "unauthorized" };
  return { orgId };
}

export type ProposeTemplateGeneralizationResult =
  | { ok: true; proposals: ProposedSubstitution[] }
  | { ok: false; error: "unauthorized" | "template_not_found" | "empty_skill_md" | "llm_failed" | "malformed_llm_output" };

/**
 * Run the LLM propose pass over a template's `customSkillMd`. Org-guarded:
 * the session's orgId must own the template (mirrors seller-actions.ts's
 * template ownership check). Read-only — proposes only, never writes.
 */
export async function proposeTemplateGeneralizationAction(input: {
  templateId: string;
}): Promise<ProposeTemplateGeneralizationResult> {
  const auth = await requireOrgAndUser();
  if ("error" in auth) return { ok: false, error: auth.error };

  const templateId = String(input.templateId ?? "").trim();
  if (!templateId) return { ok: false, error: "template_not_found" };

  const [template] = await db
    .select({ id: agentTemplates.id, blueprint: agentTemplates.blueprint })
    .from(agentTemplates)
    .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.builderOrgId, auth.orgId)))
    .limit(1);
  if (!template) return { ok: false, error: "template_not_found" };

  const customSkillMd = (template.blueprint as AgentBlueprint | null)?.customSkillMd ?? "";

  // Wrap the real LLM call to capture the UPSTREAM error (the Anthropic SDK
  // error's own message — model-not-found, 401, overloaded) before
  // `proposeTemplateGeneralization`'s try/catch swallows it into the typed
  // `llm_failed` error. This was Max's real production failure: the typed
  // error reached the UI, but nothing server-side recorded WHY the LLM call
  // failed, leaving zero trace in Vercel logs.
  let upstreamMessage: string | null = null;
  const baseLlm = makeGeneralizationLlm();
  const llm: GeneralizationLlm = async (llmArgs) => {
    try {
      return await baseLlm(llmArgs);
    } catch (err) {
      upstreamMessage = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  const result = await proposeTemplateGeneralization(customSkillMd, llm);
  if (!result.ok) {
    const model = process.env.ANTHROPIC_EVAL_MODEL?.trim() || DEFAULT_GENERALIZATION_MODEL;
    const { message, payload } = buildGeneralizeFailureLog({
      templateId,
      orgId: auth.orgId,
      result,
      model,
      upstreamMessage,
    });
    console.error(message, payload);
    return result;
  }
  return { ok: true, proposals: result.proposals };
}

export type ApplyTemplateGeneralizationResult = ApplyGeneralizationTxResult;

/**
 * Apply the operator-CONFIRMED generalization rows: rewrite the template's
 * `customSkillMd` + write `templateVariables`, AND back-fill the author's own
 * existing deployments' `customization.templateVarValues` so their live agent
 * stays byte-identical — in ONE db.transaction (never-lies: the author's own
 * agent must never observe a moment where the template is generalized but
 * their deployment isn't back-filled, or vice versa). Org-guarded.
 */
export async function applyTemplateGeneralizationAction(input: {
  templateId: string;
  rows: AcceptedGeneralizationRow[];
}): Promise<ApplyTemplateGeneralizationResult> {
  assertWritable();

  const auth = await requireOrgAndUser();
  if ("error" in auth) return { ok: false, error: auth.error };

  const templateId = String(input.templateId ?? "").trim();
  if (!templateId) return { ok: false, error: "template_not_found" };

  return applyTemplateGeneralizationTx(
    {
      loadOwnedTemplate: async ({ templateId, orgId }) => {
        const [row] = await db
          .select({ id: agentTemplates.id, blueprint: agentTemplates.blueprint })
          .from(agentTemplates)
          .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.builderOrgId, orgId)))
          .limit(1);
        if (!row) return null;
        return { id: row.id, blueprint: (row.blueprint as AgentBlueprint) ?? {} };
      },
      listAuthorDeployments: async ({ orgId, templateId }) => {
        const rows = await db
          .select({ id: deployments.id, customization: deployments.customization })
          .from(deployments)
          .where(and(eq(deployments.builderOrgId, orgId), eq(deployments.agentTemplateId, templateId)));
        return rows.map((r) => ({
          id: r.id,
          customization: (r.customization as Record<string, unknown> | null) ?? null,
        }));
      },
      persist: async ({ templateId, nextBlueprint, deploymentUpdates }) => {
        // The neon-http driver has NO `db.transaction` support (it throws "No
        // transactions support in neon-http driver" — verified against the
        // installed drizzle-orm version). `db.batch([...])` is neon-http's
        // atomic multi-statement primitive (it sends the whole array as ONE
        // transaction over Neon's HTTP endpoint) — this is what makes the
        // blueprint rewrite + every author-deployment back-fill land as a
        // single all-or-nothing unit, per the never-lies contract.
        const stamp = new Date();
        const buildTemplate = (d: typeof db) =>
          d
            .update(agentTemplates)
            .set({ blueprint: nextBlueprint, updatedAt: stamp })
            .where(eq(agentTemplates.id, templateId));
        const buildDeployment = (d: typeof db, update: (typeof deploymentUpdates)[number]) =>
          d
            .update(deployments)
            .set({ customization: update.customization, updatedAt: stamp })
            .where(eq(deployments.id, update.id));

        // Self-hosted pooled driver (DB_DRIVER=pg) has no `db.batch` but does
        // support real transactions - same all-or-nothing unit.
        if (typeof (db as { batch?: unknown }).batch !== "function") {
          await db.transaction(async (tx) => {
            await buildTemplate(tx as unknown as typeof db);
            for (const update of deploymentUpdates) {
              await buildDeployment(tx as unknown as typeof db, update);
            }
          });
          return;
        }

        const templateUpdate = buildTemplate(db);
        const deploymentQueries = deploymentUpdates.map((update) => buildDeployment(db, update));
        await db.batch([templateUpdate, ...deploymentQueries] as [
          typeof templateUpdate,
          ...typeof deploymentQueries,
        ]);
      },
    },
    { templateId, orgId: auth.orgId, rows: input.rows ?? [] },
  );
}
