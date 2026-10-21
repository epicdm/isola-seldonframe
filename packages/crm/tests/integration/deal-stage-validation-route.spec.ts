// ROUTE-LEVEL test of the REST stage writers (the path MCP move_deal_stage / update_deal / create_deal take):
// PATCH /api/v1/deals/[id] and POST /api/v1/deals, exported handlers, real workspace bearer (minted through the app's
// own mintWorkspaceToken), real guard, scratch Postgres. Written to be RED on the live base (69eeff0f), where PATCH
// accepted any stage string and emitted nothing — the mechanism that left deal 9e44e2a1 in "Proposal".
// Every refusal has its positive twin (Law 19). Opt-in: NEON_LOCAL_HOST + PL_LIFECYCLE_DB_TEST=scratch.
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";
import { eq, sql } from "drizzle-orm";

const enabled = process.env.PL_LIFECYCLE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;
const ORG = "dddddddd-0000-4000-8000-0000000000d1";
const STAGES = [
  { name: "Lead", color: "#0284c7", probability: 0 },
  { name: "Signup started", color: "#9333ea", probability: 0 },
  { name: "Paid plan", color: "#16a34a", probability: 100 },
  { name: "Lost", color: "#71717a", probability: 0 },
];

describe("REST stage writers validate against the deal's pipeline and emit deal.stage_changed", { skip: !enabled && "set PL_LIFECYCLE_DB_TEST=scratch" }, () => {
  let db: typeof import("@/db").db;
  let S: typeof import("@/db/schema");
  let PATCH: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response | undefined>;
  let POSTD: (r: Request) => Promise<Response | undefined>;
  let token = "";
  let dealId = "";
  let contactId = "";

  before(async () => {
    ({ db } = await import("@/db"));
    S = await import("@/db/schema");
    await db.execute(sql`delete from organizations where id = ${ORG}::uuid`);
    await db.insert(S.organizations).values({ id: ORG, name: "stage-ws", slug: "stage-ws" });
    const [p] = await db.insert(S.pipelines).values({ orgId: ORG, name: "Default pipeline", stages: STAGES, isDefault: true }).returning({ id: S.pipelines.id });
    const [c] = await db.insert(S.contacts).values({ orgId: ORG, firstName: "Stage test" }).returning({ id: S.contacts.id });
    contactId = c.id;
    const [d] = await db.insert(S.deals).values({ orgId: ORG, contactId, pipelineId: p.id, title: "t", stage: "Lead", probability: 0 }).returning({ id: S.deals.id });
    dealId = d.id;
    const { mintWorkspaceToken } = await import("@/lib/auth/workspace-token");
    token = (await mintWorkspaceToken(ORG, { name: "test" })).token;
    ({ PATCH } = await import("@/app/api/v1/deals/[id]/route"));
    ({ POST: POSTD } = await import("@/app/api/v1/deals/route"));
  });

  const patch = async (id: string, b: Record<string, unknown>) =>
    (await PATCH(new Request(`http://uplink.test/api/v1/deals/${id}`, { method: "PATCH", body: JSON.stringify(b), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }), { params: Promise.resolve({ id }) }))!;
  const create = async (b: Record<string, unknown>) =>
    (await POSTD(new Request("http://uplink.test/api/v1/deals", { method: "POST", body: JSON.stringify(b), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })))!;
  const deal = async () => (await db.select().from(S.deals).where(eq(S.deals.id, dealId)))[0];
  const events = async () => {
    const r: any = await db.execute(sql`select payload from workflow_event_log where org_id = ${ORG}::uuid and event_type = 'deal.stage_changed' order by emitted_at`);
    return (r.rows ?? r).map((x: any) => x.payload);
  };

  test("PATCH with a stage the pipeline does not have ('Proposal') -> 422, deal unchanged (title too), no event", async () => {
    const r = await patch(dealId, { stage: "Proposal", title: "renamed" });
    assert.equal(r.status, 422);
    const d = await deal();
    assert.equal(d.stage, "Lead");
    assert.equal(d.title, "t");
    assert.equal((await events()).length, 0);
  });

  test("PATCH with a near-miss ('lost', wrong case) -> 422 (exact names only)", async () => {
    assert.equal((await patch(dealId, { stage: "lost" })).status, 422);
    assert.equal((await deal()).stage, "Lead");
  });

  test("positive twin: PATCH to a real stage moves the deal and emits deal.stage_changed attributed to the API", async () => {
    const r = await patch(dealId, { stage: "Signup started" });
    assert.equal(r.status, 200);
    assert.equal((await deal()).stage, "Signup started");
    const ev = await events();
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].from, ev[0].to, ev[0].actor?.kind], ["Lead", "Signup started", "api"]);
  });

  test("PATCH without a stage behaves as before (title updated, no stage event)", async () => {
    const r = await patch(dealId, { title: "renamed" });
    assert.equal(r.status, 200);
    assert.equal((await deal()).title, "renamed");
    assert.equal((await events()).length, 1);
  });

  test("validation is against the deal's OWN pipeline: a stage that exists only in another pipeline is refused; the kanban core path refuses too", async () => {
    const [p2] = await db.insert(S.pipelines).values({ orgId: ORG, name: "Second", stages: [{ name: "Intake", color: "#000", probability: 0 }, { name: "Done", color: "#111", probability: 100 }], isDefault: false }).returning({ id: S.pipelines.id });
    const [d2] = await db.insert(S.deals).values({ orgId: ORG, contactId, pipelineId: p2.id, title: "p2", stage: "Intake", probability: 0 }).returning({ id: S.deals.id });
    assert.equal((await patch(d2.id, { stage: "Lost" })).status, 422);            // Lost is a DEFAULT-pipeline stage only
    assert.equal((await patch(d2.id, { stage: "Done" })).status, 200);            // positive twin: its own pipeline's stage
    const { moveDealToStage } = await import("@/lib/deals/stage-move");       // the body of moveDealStageAction (kanban)
    const r = await moveDealToStage({ orgId: ORG, dealId: dealId, stage: "Proposal", actor: { kind: "user" } });
    assert.deepEqual([r.ok, (r as any).error], [false, "unknown_stage"]);
  });

  test("POST with an unknown stage -> 422 and nothing created; positive twins: a real stage, and no stage = the pipeline's first stage", async () => {
    const before = (await db.select().from(S.deals).where(eq(S.deals.orgId, ORG))).length;
    assert.equal((await create({ contactId, title: "x", stage: "Proposal" })).status, 422);
    assert.equal((await db.select().from(S.deals).where(eq(S.deals.orgId, ORG))).length, before);
    const ok = await create({ contactId, title: "y", stage: "Lost" });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).data.stage, "Lost");
    const dflt = await create({ contactId, title: "z" });
    assert.equal(dflt.status, 201);
    assert.equal((await dflt.json()).data.stage, "Lead");
  });
});
