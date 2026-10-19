// Run (needs a DISPOSABLE Postgres with the repo migrations applied - see
// scripts/migrate-test-db.mjs):
//   TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/db \
//     node --import tsx --test tests/unit/agent-templates/persist-generalization-tx.spec.ts
//
// Proves the db.transaction fallback in persistGeneralization (the pooled
// DB_DRIVER=pg path, where db.batch does not exist) is atomic against a REAL
// Postgres through drizzle's node-postgres driver. Skipped when unset.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { organizations } from "../../../src/db/schema/organizations";
import { agentTemplates } from "../../../src/db/schema/agent-templates";
import { deployments } from "../../../src/db/schema/deployments";
import { persistGeneralization } from "../../../src/lib/agent-templates/persist-generalization";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set - skipping real-Postgres transaction test";

describe("persistGeneralization transaction fallback (real Postgres)", { skip }, () => {
  let pool: Pool;
  // Same construction as src/db/index.ts's pooled branch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let orgId: string;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ORIG_BP = { customSkillMd: "ORIGINAL skill" } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NEW_BP = { customSkillMd: "GENERALIZED skill" } as any;

  async function seed() {
    const [tpl] = await db
      .insert(agentTemplates)
      .values({
        builderOrgId: orgId,
        name: "t",
        slug: `t-${Math.random()}`,
        type: "voice_receptionist",
        blueprint: ORIG_BP,
      })
      .returning({ id: agentTemplates.id });
    const depIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [d] = await db
        .insert(deployments)
        .values({
          builderOrgId: orgId,
          agentTemplateId: tpl.id,
          clientName: `c${i}`,
          customization: { orig: i },
        })
        .returning({ id: deployments.id });
      depIds.push(d.id);
    }
    return { templateId: tpl.id as string, depIds };
  }

  async function snapshot(templateId: string, depIds: string[]) {
    const [t] = await db.select().from(agentTemplates).where(eq(agentTemplates.id, templateId));
    const ds = [];
    for (const id of depIds) {
      const [d] = await db.select().from(deployments).where(eq(deployments.id, id));
      ds.push(d);
    }
    return { t, ds };
  }

  before(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = drizzle(pool, { schema, casing: "snake_case" });
    const [o] = await db
      .insert(organizations)
      .values({ name: "txtest", slug: `txtest-${suffix}` })
      .returning({ id: organizations.id });
    orgId = o.id;
  });

  after(async () => {
    // Fixture cleanup (the scratch DB is also removed wholesale by the runner):
    // organizations -> agent_templates/deployments cascade on builder_org_id.
    if (db && orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool?.end();
  });

  test("(c) pooled node-postgres driver has no db.batch, so the transaction branch is the one taken", () => {
    assert.equal(typeof db.batch, "undefined");
    assert.equal(typeof db.transaction, "function");
  });

  test("(a) POSITIVE CONTROL: happy path commits template blueprint and every deployment customization", async () => {
    const { templateId, depIds } = await seed();
    await persistGeneralization(db, {
      templateId,
      nextBlueprint: NEW_BP,
      deploymentUpdates: depIds.map((id, i) => ({ id, customization: { backfilled: i } })),
    });
    const { t, ds } = await snapshot(templateId, depIds);
    assert.deepEqual(t.blueprint, NEW_BP);
    ds.forEach((d, i) => assert.deepEqual(d.customization, { backfilled: i }));
  });

  // Each case makes ONLY the LAST statement fail at the database, after the
  // template update and the earlier deployment updates have already executed
  // inside the open transaction.
  type Upd = Array<{ id: string; customization: Record<string, unknown> }>;
  const failures: Array<[string, (depIds: string[]) => Upd]> = [
    [
      "last update's id is not a uuid (22P02 invalid_text_representation)",
      (ids) => [
        { id: ids[0], customization: { backfilled: 0 } },
        { id: ids[1], customization: { backfilled: 1 } },
        { id: "not-a-uuid", customization: { backfilled: 2 } },
      ],
    ],
    [
      "last update's jsonb value holds a NUL char (22P05 unsupported unicode escape)",
      (ids) => [
        { id: ids[0], customization: { backfilled: 0 } },
        { id: ids[1], customization: { backfilled: 1 } },
        { id: ids[2], customization: { bad: "x\u0000y" } },
      ],
    ],
  ];
  for (const [label, build] of failures) {
    test(`(b) ROLLBACK: ${label} -> nothing changed`, async () => {
      const { templateId, depIds } = await seed();
      const pre = await snapshot(templateId, depIds);
      await assert.rejects(
        persistGeneralization(db, { templateId, nextBlueprint: NEW_BP, deploymentUpdates: build(depIds) }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err: any) => {
          // Provably a DB error (SQLSTATE class 22), not a JS-side failure.
          const code = err?.code ?? err?.cause?.code;
          assert.match(String(code), /^22/);
          return true;
        },
      );
      const post = await snapshot(templateId, depIds);
      assert.deepEqual(post.t.blueprint, ORIG_BP, "template blueprint must be rolled back");
      assert.equal(post.t.updatedAt.getTime(), pre.t.updatedAt.getTime());
      post.ds.forEach((d, i) => {
        assert.deepEqual(d.customization, { orig: i }, `deployment ${i} must keep its original value`);
        assert.equal(d.updatedAt.getTime(), pre.ds[i].updatedAt.getTime());
      });
    });
  }

  test("(b-control) the pool is still usable after a rolled-back transaction (no leaked open tx)", async () => {
    const { templateId, depIds } = await seed();
    await assert.rejects(
      persistGeneralization(db, {
        templateId,
        nextBlueprint: NEW_BP,
        deploymentUpdates: [{ id: "not-a-uuid", customization: {} }],
      }),
    );
    await persistGeneralization(db, {
      templateId,
      nextBlueprint: NEW_BP,
      deploymentUpdates: [{ id: depIds[0], customization: { ok: true } }],
    });
    const { t, ds } = await snapshot(templateId, depIds);
    assert.deepEqual(t.blueprint, NEW_BP);
    assert.deepEqual(ds[0].customization, { ok: true });
  });
});
