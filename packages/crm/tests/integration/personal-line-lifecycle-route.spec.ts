// ROUTE-LEVEL test of POST /api/webhooks/personal-line/[orgId] — the exported route handler itself, production wiring:
// real HMAC verification, real parser, real drizzle store on a SCRATCH Postgres (full schema), real link, real
// moveDealToStage (the kanban path), real emitSeldonEvent -> workflow_event_log. No seam except the env/key file.
// The four lifecycle bodies are the EXACT bytes plsvc's emitter produced in its own route-level run
// (PL_LIFECYCLE_FIXTURE_IN = plsvc test/pl-lifecycle-emitter.test.ts output); they are re-signed here with the test key
// (same signature scheme — the vector test in both repos proves it). Every refusal has its positive twin (Law 19).
//
// Opt-in, same guard as the other DB specs: refuses unless NEON_LOCAL_HOST is set AND PL_LIFECYCLE_DB_TEST=scratch.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, describe } from "node:test";

import { and, eq, sql } from "drizzle-orm";

const enabled = process.env.PL_LIFECYCLE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;
const KEY = "lifecycle-test-key-0123456789abcdef-0123"; // fictional test value, not a credential
const EPIC = "2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8";
const FOREIGN = "bbbbbbbb-0000-4000-8000-0000000000f1";
const NOSTAGE = "cccccccc-0000-4000-8000-0000000000c1";
const STAGES = [
  { name: "Lead", color: "#0284c7", probability: 0 },
  { name: "Signup started", color: "#9333ea", probability: 0 },
  { name: "Line created", color: "#d97706", probability: 0 },
  { name: "App activated", color: "#ea580c", probability: 0 },
  { name: "First call", color: "#0d9488", probability: 0 },
  { name: "Paid plan", color: "#16a34a", probability: 100 },
  { name: "Lost", color: "#71717a", probability: 0 },
];
const sign = (raw: string, ts = Math.floor(Date.now() / 1000), key = KEY) => createHmac("sha256", key).update(`${ts}.${raw}`).digest("base64url");

describe("Personal Line lifecycle ingress -> Default pipeline (route level, scratch DB)", { skip: !enabled && "set PL_LIFECYCLE_DB_TEST=scratch with a scratch database" }, () => {
  let POST: (r: Request, c: { params: Promise<{ orgId: string }> }) => Promise<Response>;
  let db: typeof import("@/db").db;
  let S: typeof import("@/db/schema");
  let produced: Record<string, string>;
  let orphanDealId = "";
  const keyFile = path.join(tmpdir(), `pl-lifecycle-key-${process.pid}`);

  const post = (orgId: string, raw: string, headers?: Record<string, string> | null) =>
    POST(new Request(`http://uplink.test/api/webhooks/personal-line/${orgId}`, {
      method: "POST", body: raw,
      headers: { "content-type": "application/json", ...(headers === null ? {} : headers ?? { "x-pl-sf-kid": "v1", "x-pl-sf-ts": String(Math.floor(Date.now() / 1000)), "x-pl-sf-sig": sign(raw) }) },
    }), { params: Promise.resolve({ orgId }) });
  const body = (type: string, subject: string, over: Record<string, unknown> = {}) => {
    const base = JSON.parse(produced[type]);
    return JSON.stringify({ ...base, event_id: randomUUID(), subject_id: subject, ...over });
  };
  const count = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as any).rows?.[0]?.n ?? (await db.execute(q) as any)[0]?.n);
  const dealsOf = async (orgId: string) => db.select().from(S.deals).where(eq(S.deals.orgId, orgId));
  const plDealOf = async (orgId: string, subject: string) => (await dealsOf(orgId)).filter((d) => (d.customFields as any)?.plSubjectId === subject);
  const stageEvents = async (orgId: string) => {
    const r: any = await db.execute(sql`select payload from workflow_event_log where org_id = ${orgId}::uuid and event_type = 'deal.stage_changed' order by emitted_at`);
    return (r.rows ?? r).map((x: any) => x.payload);
  };

  before(async () => {
    produced = JSON.parse(readFileSync(String(process.env.PL_LIFECYCLE_FIXTURE_IN), "utf8"));
    assert.deepEqual(Object.keys(produced).sort(), ["pl.app_activated", "pl.first_call", "pl.line_created", "pl.signup_started"]);
    writeFileSync(keyFile, KEY + "\n");
    ({ db } = await import("@/db"));
    S = await import("@/db/schema");
    for (const [id, slug] of [[EPIC, "epic-pl"], [FOREIGN, "foreign-ws"], [NOSTAGE, "nostage-ws"]] as const) {
      await db.execute(sql`delete from organizations where id = ${id}::uuid`);
      await db.insert(S.organizations).values({ id, name: slug, slug });
      const [u] = await db.insert(S.users).values({ orgId: id, name: `${slug} owner`, email: `${slug}@example.test` }).returning({ id: S.users.id });
      await db.update(S.organizations).set({ ownerId: u.id }).where(eq(S.organizations.id, id));
    }
    const [p] = await db.insert(S.pipelines).values({ orgId: EPIC, name: "Default pipeline", stages: STAGES, isDefault: true }).returning({ id: S.pipelines.id });
    await db.insert(S.pipelines).values({ orgId: FOREIGN, name: "Default pipeline", stages: STAGES, isDefault: true });
    await db.insert(S.pipelines).values({ orgId: NOSTAGE, name: "Default pipeline", stages: STAGES.filter((s) => s.name !== "Line created"), isDefault: true });
    // the orphaned synthetic "Proposal" deal: must survive everything below untouched
    const [c] = await db.insert(S.contacts).values({ orgId: EPIC, firstName: "SYNTHETIC intake", source: "intake" }).returning({ id: S.contacts.id });
    const [d] = await db.insert(S.deals).values({ orgId: EPIC, contactId: c.id, pipelineId: p.id, title: "SYNTHETIC - Personal Line sandbox deal", value: "1.00", stage: "Proposal", probability: 10 }).returning({ id: S.deals.id });
    orphanDealId = d.id;
    // a self-entered contact carrying the subscriber's phone: must NEVER be adopted
    await db.insert(S.contacts).values({ orgId: EPIC, firstName: "Form", phone: `+${JSON.parse(produced["pl.signup_started"]).wa_id}`, source: "intake" });
    ({ POST } = await import("@/app/api/webhooks/personal-line/[orgId]/route"));
  });

  const configure = () => {
    process.env.PL_LIFECYCLE_KEY_FILE = keyFile;
    process.env.PL_LIFECYCLE_KID = "v1";
    process.env.PL_LIFECYCLE_TENANT_ORGS = `epic=${EPIC},nostage=${NOSTAGE}`;
  };

  test("NOT CONFIGURED (deployed dark): 503 and nothing written; positive twin: the same signed body is accepted once configured", async () => {
    for (const k of ["PL_LIFECYCLE_KEY_FILE", "PL_LIFECYCLE_KID", "PL_LIFECYCLE_TENANT_ORGS"]) delete process.env[k];
    const raw = body("pl.signup_started", "subj_dark");
    assert.equal((await post(EPIC, raw)).status, 503);
    assert.equal(await count(sql`select count(*)::int n from integration_event_inbox where external_id = 'subj_dark'`), 0);
    configure();
    assert.equal((await post(EPIC, raw)).status, 200);
  });

  test("FORGED: unsigned, wrong key, wrong kid, tampered body, expired timestamp -> 401, nothing recorded; positive twin = the full journey below", async () => {
    configure();
    const raw = body("pl.signup_started", "subj_forged");
    const ts = Math.floor(Date.now() / 1000);
    const cases: Array<[Record<string, string> | null, string]> = [
      [null, raw],
      [{ "x-pl-sf-kid": "v1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": sign(raw, ts, "another-key-0123456789abcdef-0123456789") }, raw],
      [{ "x-pl-sf-kid": "v2", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": sign(raw, ts) }, raw],
      [{ "x-pl-sf-kid": "v1", "x-pl-sf-ts": String(ts), "x-pl-sf-sig": sign(raw, ts) }, raw.replace('"epic"', '"epic" ')],
      [{ "x-pl-sf-kid": "v1", "x-pl-sf-ts": String(ts - 3600), "x-pl-sf-sig": sign(raw, ts - 3600) }, raw],
    ];
    for (const [h, b] of cases) assert.equal((await post(EPIC, b, h)).status, 401);
    assert.equal(await count(sql`select count(*)::int n from integration_event_inbox where external_id = 'subj_forged'`), 0);
  });

  test("THE JOURNEY (plsvc's own bytes): one contact, one deal, Signup started -> Line created -> App activated -> First call, each move a deal.stage_changed attributed to the integration", async () => {
    configure();
    const subject = JSON.parse(produced["pl.signup_started"]).subject_id;
    const before = (await stageEvents(EPIC)).length;
    const expect = ["Signup started", "Line created", "App activated", "First call"];
    for (const [i, type] of ["pl.signup_started", "pl.line_created", "pl.app_activated", "pl.first_call"].entries()) {
      const r = await post(EPIC, produced[type]);
      assert.equal(r.status, 200, type);
      const ds = await plDealOf(EPIC, subject);
      assert.equal(ds.length, 1, `one deal after ${type}`);
      assert.equal(ds[0].stage, expect[i]);
    }
    const evs = (await stageEvents(EPIC)).slice(before);
    assert.deepEqual(evs.map((e: any) => [e.from, e.to, e.actor?.kind, e.actor?.name]), [
      ["Signup started", "Line created", "integration", "personal_line"],
      ["Line created", "App activated", "integration", "personal_line"],
      ["App activated", "First call", "integration", "personal_line"],
    ]);
    const [deal] = await plDealOf(EPIC, subject);
    assert.equal((deal.customFields as any).plAccountId, JSON.parse(produced["pl.line_created"]).pl_account_id);
    // the contact is NEW (source personal_line), linked by identity; the self-entered one with the same phone is not adopted
    const ident: any = await db.execute(sql`select contact_id from external_identities where org_id = ${EPIC}::uuid and external_id = ${subject}`);
    const contactId = (ident.rows ?? ident)[0].contact_id;
    assert.equal(deal.contactId, contactId);
    const [ct] = await db.select().from(S.contacts).where(eq(S.contacts.id, contactId));
    assert.equal(ct.source, "personal_line");
    // first call: the timeline shows the CALL time; detection time is kept separately
    const fc = JSON.parse(produced["pl.first_call"]);
    const acts = await db.select().from(S.activities).where(and(eq(S.activities.orgId, EPIC), eq(S.activities.contactId, contactId)));
    assert.equal(acts.length, 4);
    const fcAct = acts.find((a) => (a.metadata as any).event_type === "pl.first_call")!;
    assert.equal(new Date(fcAct.completedAt!).toISOString(), fc.facts.first_call_at);
    assert.equal((fcAct.metadata as any).detected_at, fc.facts.first_call_detected_at);
    assert.notEqual(fc.facts.first_call_at, fc.facts.first_call_detected_at);
  });

  test("REPLAY: every body delivered again -> 200 duplicate, nothing new (no contact, deal, activity or stage event)", async () => {
    configure();
    const snap = async () => [await count(sql`select count(*)::int n from contacts where org_id = ${EPIC}::uuid`), (await dealsOf(EPIC)).length,
      await count(sql`select count(*)::int n from activities where org_id = ${EPIC}::uuid`), (await stageEvents(EPIC)).length];
    const s0 = await snap();
    for (const type of Object.keys(produced)) {
      const r = await post(EPIC, produced[type]);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).status, "duplicate");
    }
    assert.deepEqual(await snap(), s0);
  });

  test("OUT OF ORDER: first call arrives first -> deal created AT First call; the older events never move it back", async () => {
    configure();
    const ev0 = (await stageEvents(EPIC)).length;
    assert.equal((await post(EPIC, body("pl.first_call", "subj_ooo"))).status, 200);
    assert.equal((await plDealOf(EPIC, "subj_ooo"))[0].stage, "First call");
    for (const t of ["pl.signup_started", "pl.line_created", "pl.app_activated"]) {
      const r = await post(EPIC, body(t, "subj_ooo"));
      assert.equal(r.status, 200);
      assert.match((await r.json()).deal, /^kept:not_forward/);
    }
    const ds = await plDealOf(EPIC, "subj_ooo");
    assert.equal(ds.length, 1);
    assert.equal(ds[0].stage, "First call");
    assert.equal((await stageEvents(EPIC)).length, ev0);
  });

  test("MANUAL STAGES ARE NEVER AUTOMATED: an operator's Paid plan / Lost card stays put; no event type reaches them", async () => {
    configure();
    for (const [subj, manual] of [["subj_paid", "Paid plan"], ["subj_lost", "Lost"]] as const) {
      await post(EPIC, body("pl.signup_started", subj));
      const [d] = await plDealOf(EPIC, subj);
      await db.update(S.deals).set({ stage: manual }).where(eq(S.deals.id, d.id));   // the operator's own move
      for (const t of ["pl.line_created", "pl.app_activated", "pl.first_call"]) await post(EPIC, body(t, subj));
      assert.equal((await plDealOf(EPIC, subj))[0].stage, manual);
    }
    const { STAGE_FOR } = await import("@/lib/personal-line/lifecycle");
    const targets = Object.values(STAGE_FOR).map((x) => x.stage);
    assert.ok(!targets.includes("Paid plan") && !targets.includes("Lost") && !targets.includes("Lead"));
    // positive twin: an unconstrained subject IS moved by the same events
    await post(EPIC, body("pl.signup_started", "subj_free")); await post(EPIC, body("pl.line_created", "subj_free"));
    assert.equal((await plDealOf(EPIC, "subj_free"))[0].stage, "Line created");
  });

  test("CONCURRENT first events for one subject -> exactly one deal, at the furthest stage", async () => {
    configure();
    const rs = await Promise.all([post(EPIC, body("pl.signup_started", "subj_race")), post(EPIC, body("pl.line_created", "subj_race")), post(EPIC, body("pl.app_activated", "subj_race"))]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    const ds = await plDealOf(EPIC, "subj_race");
    assert.equal(ds.length, 1);
    assert.equal(ds[0].stage, "App activated");
    assert.equal(await count(sql`select count(*)::int n from external_identities where org_id = ${EPIC}::uuid and external_id = 'subj_race'`), 1);
  });

  test("FOREIGN / UNKNOWN TENANT: unknown tenant -> 403; EPIC's tenant aimed at another workspace's path -> 403; nothing written there", async () => {
    configure();
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_t1", { tenant: "other" }))).status, 403);
    assert.equal((await post(FOREIGN, body("pl.signup_started", "subj_t2"))).status, 403);
    assert.equal((await post(NOSTAGE, body("pl.signup_started", "subj_t3"))).status, 403);   // epic's tenant, allowlisted path of ANOTHER tenant
    assert.equal((await dealsOf(FOREIGN)).length, 0);
    assert.equal(await count(sql`select count(*)::int n from integration_event_inbox where external_id in ('subj_t1','subj_t2','subj_t3')`), 0);
    // positive twin: the second allowlisted tenant on its own path is accepted
    assert.equal((await post(NOSTAGE, body("pl.signup_started", "subj_t4", { tenant: "nostage" }))).status, 200);
  });

  test("UNKNOWN STAGE / TYPE: a type outside the four (e.g. plan_purchased) -> 422; a pipeline without the target stage -> event recorded, NO deal write", async () => {
    configure();
    const pp = JSON.stringify({ ...JSON.parse(body("pl.signup_started", "subj_pp")), type: "pl.plan_purchased" });
    assert.equal((await post(EPIC, pp)).status, 422);
    const r = await post(NOSTAGE, body("pl.line_created", "subj_ns", { tenant: "nostage" }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).deal, "stage_missing:Line created");
    assert.equal((await plDealOf(NOSTAGE, "subj_ns")).length, 0);
    assert.equal(await count(sql`select count(*)::int n from integration_event_inbox where external_id = 'subj_ns' and outcome = 'stage_missing:Line created'`), 1);
  });

  test("a detection time is never accepted as the event time (first_call occurred_at must equal first_call_at or be null)", async () => {
    configure();
    const fc = JSON.parse(produced["pl.first_call"]);
    const lie = body("pl.first_call", "subj_lie", { occurred_at: fc.detected_at });
    assert.equal((await post(EPIC, lie)).status, 422);
    const unknownTime = body("pl.first_call", "subj_unk", { occurred_at: null, facts: { first_call_at: null, first_call_detected_at: fc.facts.first_call_detected_at } });
    assert.equal((await post(EPIC, unknownTime)).status, 200);
  });

  test("Codex r1 P1: an UNFINISHED claim (crashed worker, inside 30 s) -> 503 retryable, never a 200 duplicate; after the reclaim window it is processed", async () => {
    configure();
    const raw = body("pl.signup_started", "subj_inprog");
    const e = JSON.parse(raw);
    await db.execute(sql`insert into integration_event_inbox (org_id, provider, event_id, external_id, type, occurred_at, detected_at, version, received_at)
      values (${EPIC}::uuid, 'personal_line', ${e.event_id}, 'subj_inprog', 'pl.signup_started', now(), now(), 1, now())`);
    const r1 = await post(EPIC, raw);
    assert.equal(r1.status, 503);
    assert.equal((await r1.json()).error, "event_in_progress");
    assert.equal((await plDealOf(EPIC, "subj_inprog")).length, 0);
    await db.execute(sql`update integration_event_inbox set received_at = now() - interval '5 minutes' where event_id = ${e.event_id}`);
    const r2 = await post(EPIC, raw);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).status, "processed");
    assert.equal((await plDealOf(EPIC, "subj_inprog")).length, 1);
    const r3 = await post(EPIC, raw);                                  // positive twin of "duplicate": FINISHED -> 200 duplicate
    assert.equal((await r3.json()).status, "duplicate");
  });

  test("Codex r2: a RECLAIM racing the original worker (both run the whole event) -> exactly one activity, one pl.* log row, one deal.stage_changed", async () => {
    configure();
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_race2"))).status, 200);
    const raw = body("pl.line_created", "subj_race2");
    const e = JSON.parse(raw);
    // a stale unfinished claim => BOTH concurrent deliveries can reclaim/claim and process
    await db.execute(sql`insert into integration_event_inbox (org_id, provider, event_id, external_id, type, occurred_at, detected_at, version, received_at)
      values (${EPIC}::uuid, 'personal_line', ${e.event_id}, 'subj_race2', 'pl.line_created', now(), now(), 2, now() - interval '5 minutes')`);
    const { drizzleLifecycleStore, processLifecycleEvent, parseLifecycleEvent } = await import("@/lib/personal-line/lifecycle");
    const { moveDealToStage } = await import("@/lib/deals/stage-move");
    const { emitSeldonEvent } = await import("@/lib/events/bus");
    const ev = parseLifecycleEvent(raw)!;
    const store = await drizzleLifecycleStore();
    // force BOTH workers past the claim (the second sees the first's fresh claim otherwise): give the second its own "new"
    const s2 = { ...store, claimEvent: async () => "new" as const };
    const emit = (t: any, d: any, o: string, id: string) => emitSeldonEvent(t, d, { orgId: o, preLoggedEventId: id });
    const [a, b] = await Promise.all([
      processLifecycleEvent(EPIC, ev, store, emit, (i) => moveDealToStage(i)),
      processLifecycleEvent(EPIC, ev, s2, emit, (i) => moveDealToStage(i)),
    ]);
    assert.equal(a.status, "processed"); assert.equal(b.status, "processed");
    const [d] = await plDealOf(EPIC, "subj_race2");
    assert.equal(d.stage, "Line created");
    assert.equal(await count(sql`select count(*)::int n from activities where org_id = ${EPIC}::uuid and metadata->>'event_id' = ${e.event_id}`), 1);
    assert.equal(await count(sql`select count(*)::int n from workflow_event_log where org_id = ${EPIC}::uuid and event_type = 'pl.line_created' and payload->>'eventId' = ${e.event_id}`), 1);
    assert.equal((await stageEvents(EPIC)).filter((x: any) => x.dealId === d.id && x.to === "Line created").length, 1);
  });

  test("Codex r3: crash AFTER the durable log rows but BEFORE their dispatch -> the reclaimed event dispatches them (no new log rows); a later replay does not", async () => {
    configure();
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_disp"))).status, 200);
    const raw = body("pl.line_created", "subj_disp");
    const e = JSON.parse(raw);
    const [d] = await plDealOf(EPIC, "subj_disp");
    // the crashed worker's durable state: card moved + its stage row (same statement), pl.* row logged, nothing dispatched, not finished
    await db.update(S.deals).set({ stage: "Line created" }).where(eq(S.deals.id, d.id));
    await db.execute(sql`insert into workflow_event_log (org_id, event_type, payload) values (${EPIC}::uuid, 'deal.stage_changed',
      ${JSON.stringify({ dealId: d.id, from: "Signup started", to: "Line created", actor: { kind: "integration", name: "personal_line", ref: e.event_id } })}::jsonb)`);
    await db.execute(sql`insert into workflow_event_log (org_id, event_type, payload) values (${EPIC}::uuid, 'pl.line_created', ${JSON.stringify({ eventId: e.event_id, subjectId: "subj_disp" })}::jsonb)`);
    await db.execute(sql`insert into integration_event_inbox (org_id, provider, event_id, external_id, type, occurred_at, detected_at, version, received_at, event_logged, activity_logged)
      values (${EPIC}::uuid, 'personal_line', ${e.event_id}, 'subj_disp', 'pl.line_created', now(), now(), 2, now() - interval '5 minutes', true, false)`);
    // drive the real processor + real store; the dispatcher is recorded (the route wires it to emitSeldonEvent with
    // preLoggedEventId, which never writes a log row — asserted below by the unchanged row count)
    const { drizzleLifecycleStore, processLifecycleEvent, parseLifecycleEvent } = await import("@/lib/personal-line/lifecycle");
    const { moveDealToStage } = await import("@/lib/deals/stage-move");
    const seen: Array<[string, string]> = [];
    const emit = async (t: string, _d: unknown, _o: string, id: string) => { seen.push([t, id]); };
    const logRows = async () => count(sql`select count(*)::int n from workflow_event_log where org_id = ${EPIC}::uuid and (payload->>'eventId' = ${e.event_id} or payload->'actor'->>'ref' = ${e.event_id})`);
    const before = await logRows();
    const store = await drizzleLifecycleStore();
    const r = await processLifecycleEvent(EPIC, parseLifecycleEvent(raw)!, store, emit as any, (i) => moveDealToStage(i));
    assert.equal(r.status, "processed");
    assert.deepEqual(seen.map((x) => x[0]).sort(), ["deal.stage_changed", "pl.line_created"]);   // both re-dispatched, by their stored ids
    assert.ok(seen.every((x) => /^[0-9a-f-]{36}$/.test(x[1])));
    assert.equal(await logRows(), before);                                  // no new log rows
    const again = await processLifecycleEvent(EPIC, parseLifecycleEvent(raw)!, store, emit as any, (i) => moveDealToStage(i));
    assert.equal(again.status, "duplicate");
    assert.equal(seen.length, 2);                                           // no further dispatch
  });

  test("Codex r4: a FAILED dispatch (pl.* or stage) leaves the event unfinished; the sender's retry reclaims it and re-dispatches the saved rows once", async () => {
    configure();
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_dfail"))).status, 200);
    const raw = body("pl.line_created", "subj_dfail");
    const e = JSON.parse(raw);
    const { drizzleLifecycleStore, processLifecycleEvent, parseLifecycleEvent } = await import("@/lib/personal-line/lifecycle");
    const { moveDealToStage, StageDispatchError } = await import("@/lib/deals/stage-move");
    const store = await drizzleLifecycleStore();
    const ev = parseLifecycleEvent(raw)!;
    // attempt 1: the move commits (with its audit row) but its dispatch fails; the pl.* dispatch fails too
    const failingMove = async (i: any) => { const r = await moveDealToStage(i); if (r.ok) throw new StageDispatchError(new Error("enqueue down")); return r; };
    const failingEmit = async () => { throw new Error("enqueue down"); };
    await assert.rejects(processLifecycleEvent(EPIC, ev, store, failingEmit as any, failingMove));
    assert.equal((await plDealOf(EPIC, "subj_dfail"))[0].stage, "Line created");      // the move itself stands
    const st: any = await db.execute(sql`select outcome, event_logged, event_dispatched, stage_dispatched from integration_event_inbox where event_id = ${e.event_id}`);
    assert.deepEqual((st.rows ?? st)[0], { outcome: null, event_logged: true, event_dispatched: false, stage_dispatched: false });
    // a retry inside 30 s is told to come back (503), not "duplicate"
    const early = await post(EPIC, raw);
    assert.equal(early.status, 503);
    // retry after the reclaim window: both saved rows re-dispatched, nothing re-logged, then finished
    await db.execute(sql`update integration_event_inbox set received_at = now() - interval '5 minutes' where event_id = ${e.event_id}`);
    const seen: string[] = [];
    const rec = async (t: string) => { seen.push(t); };
    const r2 = await processLifecycleEvent(EPIC, ev, store, rec as any, (i) => moveDealToStage(i));
    assert.equal(r2.status, "processed");
    assert.deepEqual(seen.sort(), ["deal.stage_changed", "pl.line_created"]);
    assert.equal(await count(sql`select count(*)::int n from workflow_event_log where org_id = ${EPIC}::uuid and (payload->>'eventId' = ${e.event_id} or payload->'actor'->>'ref' = ${e.event_id})`), 2);
    assert.equal(await count(sql`select count(*)::int n from activities where org_id = ${EPIC}::uuid and metadata->>'event_id' = ${e.event_id}`), 1);
    const r3 = await post(EPIC, raw);
    assert.equal((await r3.json()).status, "duplicate");
  });

  test("Codex r2: the stage write and its deal.stage_changed row are ONE statement — a lost CAS writes neither", async () => {
    configure();
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_cas"))).status, 200);
    const [d] = await plDealOf(EPIC, "subj_cas");
    const before = (await stageEvents(EPIC)).filter((x: any) => x.dealId === d.id).length;
    const { moveDealToStage } = await import("@/lib/deals/stage-move");
    // two movers from the same read: exactly one wins; the loser gets conflict and logs nothing
    const rs = await Promise.all([1, 2, 3].map(() => moveDealToStage({ orgId: EPIC, dealId: d.id, stage: "Line created", actor: { kind: "integration", name: "personal_line", ref: "t" }, forwardOnly: true })));
    const ok = rs.filter((r) => r.ok).length;
    assert.equal(ok, 1);
    assert.equal((await stageEvents(EPIC)).filter((x: any) => x.dealId === d.id).length, before + 1);
  });

  test("Codex r1 P1: crash between contact insert and identity insert -> the replay reuses THAT contact (deterministic id), never a second one", async () => {
    configure();
    const { subjectContactId } = await import("@/lib/personal-line/link");
    const cid = subjectContactId(EPIC, "personal_line", "subj_orphan");
    await db.insert(S.contacts).values({ id: cid, orgId: EPIC, firstName: "Personal Line subscriber", source: "personal_line" });   // the crashed half
    assert.equal((await post(EPIC, body("pl.signup_started", "subj_orphan"))).status, 200);
    const ident: any = await db.execute(sql`select contact_id from external_identities where org_id = ${EPIC}::uuid and external_id = 'subj_orphan'`);
    assert.equal((ident.rows ?? ident)[0].contact_id, cid);
    assert.equal(await count(sql`select count(*)::int n from contacts where org_id = ${EPIC}::uuid and id = ${cid}::uuid`), 1);
    assert.equal((await plDealOf(EPIC, "subj_orphan"))[0].contactId, cid);
  });

  test("Codex r1 P2: date-only / zone-less timestamps and duplicated JSON members are refused (422); the canonical form is accepted", async () => {
    configure();
    const base = JSON.parse(body("pl.signup_started", "subj_ts"));
    for (const bad of ["2026-10-21", "2026-10-21T15:07:58", "2026-10-21 15:07:58Z"]) {
      assert.equal((await post(EPIC, JSON.stringify({ ...base, event_id: randomUUID(), occurred_at: bad }))).status, 422, bad);
    }
    const dup = JSON.stringify({ ...base, event_id: randomUUID() }).replace('"tenant":"epic"', '"tenant":"epic","tenant":"epic"');
    assert.ok(dup.includes('"tenant":"epic","tenant":"epic"'));
    assert.equal((await post(EPIC, dup)).status, 422);
    const escaped = JSON.stringify({ ...base, event_id: randomUUID() }).replace('"tenant":"epic"', '"tenant":"other","ten\\u0061nt":"epic"');
    assert.ok(escaped.includes("\\u0061"));
    assert.equal((await post(EPIC, escaped)).status, 422);
    assert.equal((await post(EPIC, JSON.stringify({ ...base, event_id: randomUUID(), occurred_at: "2026-10-21T15:07:58+00:00" }))).status, 200);
  });

  test("app activated: event time is the REGISTER's own time or null; an observation time in occurred_at is refused", async () => {
    configure();
    const a = JSON.parse(produced["pl.app_activated"]);
    assert.ok(a.facts.registration_observed_at);
    const lie = body("pl.app_activated", "subj_obs", { occurred_at: a.facts.registration_observed_at, facts: { ...a.facts, registered_at: null } });
    assert.equal((await post(EPIC, lie)).status, 422);
    const honest = body("pl.app_activated", "subj_obs", { occurred_at: null, facts: { ...a.facts, registered_at: null } });
    assert.equal((await post(EPIC, honest)).status, 200);
  });

  test("the orphaned synthetic 'Proposal' deal is untouched by all of the above", async () => {
    const [d] = await db.select().from(S.deals).where(eq(S.deals.id, orphanDealId));
    assert.equal(d.stage, "Proposal");
    assert.equal(d.probability, 10);
  });
});
