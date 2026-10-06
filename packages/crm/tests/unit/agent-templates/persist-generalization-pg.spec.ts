import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "../../../src/db/schema";
import { organizations } from "../../../src/db/schema/organizations";
import { agentTemplates } from "../../../src/db/schema/agent-templates";
import { deployments } from "../../../src/db/schema/deployments";
import type { AgentBlueprint } from "../../../src/db/schema/agents";
import { persistPgGeneralization } from "../../../src/lib/agent-templates/persist-generalization";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not configured";

describe("pooled PostgreSQL generalization transactions", { skip }, () => {
  let pool: Pool | undefined;
  let db: PgDatabase<any, typeof schema>;
  let orgId = "";
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const original: AgentBlueprint = { customSkillMd: "Original text" };
  const generalized: AgentBlueprint = { customSkillMd: "Generalized text" };

  async function seed() {
    const [template] = await db.insert(agentTemplates).values({
      builderOrgId: orgId,
      name: "transaction test",
      slug: `tx-${Math.random()}`,
      type: "voice_receptionist",
      blueprint: original,
    }).returning({ id: agentTemplates.id });
    const deploymentIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const [deployment] = await db.insert(deployments).values({
        builderOrgId: orgId,
        agentTemplateId: template.id,
        clientName: `client-${index}`,
        customization: { script: `original-${index}` },
      }).returning({ id: deployments.id });
      deploymentIds.push(deployment.id);
    }
    return { templateId: template.id, deploymentIds };
  }

  async function snapshot(templateId: string, deploymentIds: string[]) {
    const [template] = await db.select().from(agentTemplates).where(eq(agentTemplates.id, templateId));
    const rows = [];
    for (const id of deploymentIds) {
      const [row] = await db.select().from(deployments).where(eq(deployments.id, id));
      rows.push(row);
    }
    return { template, rows };
  }

  before(async () => {
    if (!url) return;
    pool = new Pool({ connectionString: url, max: 4, allowExitOnIdle: true });
    db = drizzle(pool, { schema, casing: "snake_case" });
    const [org] = await db.insert(organizations).values({
      name: "transaction test",
      slug: `tx-${suffix}`,
    }).returning({ id: organizations.id });
    orgId = org.id;
  });

  after(async () => {
    if (url && orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool?.end();
  });

  test("successful transaction commits template and every deployment update", async () => {
    const { templateId, deploymentIds } = await seed();
    await persistPgGeneralization(db, {
      templateId,
      nextBlueprint: generalized,
      deploymentUpdates: deploymentIds.map((id, index) => ({
        id,
        customization: { script: `updated-${index}` },
      })),
    });
    const result = await snapshot(templateId, deploymentIds);
    assert.deepEqual(result.template.blueprint, generalized);
    result.rows.forEach((row, index) => assert.deepEqual(row.customization, { script: `updated-${index}` }));
  });

  test("failure in the final operation rolls back all earlier writes", async () => {
    const { templateId, deploymentIds } = await seed();
    const beforeState = await snapshot(templateId, deploymentIds);
    await assert.rejects(
      persistPgGeneralization(db, {
        templateId,
        nextBlueprint: generalized,
        deploymentUpdates: [
          { id: deploymentIds[0], customization: { script: "changed-0" } },
          { id: deploymentIds[1], customization: { script: "changed-1" } },
          { id: "not-a-uuid", customization: { script: "changed-2" } },
        ],
      }),

    );
    const afterState = await snapshot(templateId, deploymentIds);
    assert.deepEqual(afterState.template.blueprint, beforeState.template.blueprint);
    assert.equal(afterState.template.updatedAt.getTime(), beforeState.template.updatedAt.getTime());
    afterState.rows.forEach((row, index) => {
      assert.deepEqual(row.customization, beforeState.rows[index].customization);
      assert.equal(row.updatedAt.getTime(), beforeState.rows[index].updatedAt.getTime());
    });
  });

  test("pool remains usable after a rollback", async () => {
    const { templateId, deploymentIds } = await seed();
    await assert.rejects(
      persistPgGeneralization(db, {
        templateId,
        nextBlueprint: generalized,
        deploymentUpdates: [{ id: "not-a-uuid", customization: {} }],
      }),
    );
    await persistPgGeneralization(db, {
      templateId,
      nextBlueprint: generalized,
      deploymentUpdates: [{ id: deploymentIds[0], customization: { script: "recovered" } }],
    });
    const result = await snapshot(templateId, deploymentIds);
    assert.deepEqual(result.template.blueprint, generalized);
    assert.deepEqual(result.rows[0].customization, { script: "recovered" });
  });

  test("an idle one-shot pg query process exits without explicit pool.end()", { timeout: 12_000 }, () => {
    const script = "import { db } from './src/db/index.ts'; import { sql } from 'drizzle-orm'; await db.execute(sql`select 1`);";
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 8_000,
      env: {
        ...process.env,
        DB_DRIVER: "pg",
        DATABASE_URL: url ?? "",
        NEON_LOCAL_HOST: "",
      },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
  });
});
