// The atomic write behind applyTemplateGeneralizationAction's `persist` dep,
// extracted (behaviour-identical) so it can be exercised against a real
// Postgres. It lives outside generalize-actions.ts because that file is
// "use server": every export there becomes a client-callable server action,
// and this function takes a db handle.
//
// Never-lies contract: the template blueprint rewrite and every author
// deployment back-fill land as ONE all-or-nothing unit.
//   - neon-http: no db.transaction support; db.batch([...]) is the atomic
//     multi-statement primitive (one transaction over Neon's HTTP endpoint).
//   - self-hosted pooled node-postgres (DB_DRIVER=pg): no db.batch, but real
//     transactions via db.transaction.

import { eq } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { agentTemplates } from "@/db/schema/agent-templates";
import { deployments } from "@/db/schema/deployments";
import type { AgentBlueprint } from "@/db/schema/agents";

type Db = typeof appDb;

export type PersistGeneralizationInput = {
  templateId: string;
  nextBlueprint: AgentBlueprint;
  deploymentUpdates: Array<{ id: string; customization: Record<string, unknown> }>;
};

export async function persistGeneralization(
  db: Db,
  { templateId, nextBlueprint, deploymentUpdates }: PersistGeneralizationInput,
): Promise<void> {
  const stamp = new Date();
  const buildTemplate = (d: Db) =>
    d
      .update(agentTemplates)
      .set({ blueprint: nextBlueprint, updatedAt: stamp })
      .where(eq(agentTemplates.id, templateId));
  const buildDeployment = (d: Db, update: (typeof deploymentUpdates)[number]) =>
    d
      .update(deployments)
      .set({ customization: update.customization, updatedAt: stamp })
      .where(eq(deployments.id, update.id));

  // Self-hosted pooled driver (DB_DRIVER=pg) has no `db.batch` but does
  // support real transactions - same all-or-nothing unit.
  if (typeof (db as { batch?: unknown }).batch !== "function") {
    await db.transaction(async (tx) => {
      await buildTemplate(tx as unknown as Db);
      for (const update of deploymentUpdates) {
        await buildDeployment(tx as unknown as Db, update);
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
}
