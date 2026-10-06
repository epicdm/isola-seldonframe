import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { agentTemplates } from "@/db/schema/agent-templates";
import { deployments } from "@/db/schema/deployments";
import type { AgentBlueprint } from "@/db/schema/agents";

export type PersistGeneralizationInput = {
  templateId: string;
  nextBlueprint: AgentBlueprint;
  deploymentUpdates: Array<{ id: string; customization: Record<string, unknown> }>;
};

/** Persists the full generalization using node-postgres transaction semantics. */
export async function persistPgGeneralization(
  db: PgDatabase<any, typeof schema>,
  { templateId, nextBlueprint, deploymentUpdates }: PersistGeneralizationInput,
): Promise<void> {
  const stamp = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(agentTemplates)
      .set({ blueprint: nextBlueprint, updatedAt: stamp })
      .where(eq(agentTemplates.id, templateId));
    for (const update of deploymentUpdates) {
      await tx
        .update(deployments)
        .set({ customization: update.customization, updatedAt: stamp })
        .where(eq(deployments.id, update.id));
    }
  });
}
