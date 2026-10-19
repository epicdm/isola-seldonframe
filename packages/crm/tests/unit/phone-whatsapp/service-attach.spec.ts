// The attach operation against a FICTIONAL in-memory provisioner (no Magnus, no PBX, no database, no network). Every refusal has a positive control in the
// same harness. The fake provisioner is idempotent by key like the real contract requires, records every call, and THROWS on any operation outside the
// four-method interface (e.g. a charge or a delete), so "no duplicate, no charge, nothing deleted" is asserted by construction, not by hope.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachService, type AttachLedger, type AttachLedgerRecord, type AttachStepName, type Preconditions, type Provisioner } from "../../../src/lib/phone-whatsapp/service/attach";
import { selectableDestinations, type AgentDirectory, type DestinationOption } from "../../../src/lib/phone-whatsapp/service/destinations";

const WS_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const WS_B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const PHONE = "900000000000002";
const D_QUEUE: DestinationOption = { id: "d-queue-a", label: "Front desk queue", kind: "pbx_queue", target: { trunk: "pbx-fictional-a", ext: "900" }, workspaceId: WS_A, status: "active" };
const D_AGENT: DestinationOption = { id: "d-agent-a", label: "Reception agent", kind: "voice_agent", target: { agentRef: "agent-fictional-1" }, workspaceId: WS_A, status: "active" };
const D_OTHER: DestinationOption = { id: "d-queue-b", label: "B's queue", kind: "pbx_queue", target: { trunk: "pbx-fictional-b", ext: "901" }, workspaceId: WS_B, status: "active" };

type Faults = { failBefore?: string; failAfter?: string; mismatch?: boolean; readBackThrows?: boolean; delayMs?: number };

function fakeProv(faults: Faults = {}) {
  const accounts = new Map<string, string>(), dids = new Map<string, string>(), routes = new Map<string, { didRef: string; target: string }>();
  const calls: string[] = [];
  const allowed = new Set(["ensureServiceAccount", "ensureDid", "ensureDestination", "readBack"]);
  const f = { ...faults };
  const impl: Provisioner = {
    async ensureServiceAccount(a) {
      calls.push("acct"); if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.failBefore === "acct") { f.failBefore = undefined; throw new Error("timeout"); }
      const had = accounts.has(a.key); if (!had) accounts.set(a.key, `acct-${accounts.size + 1}`);
      if (f.failAfter === "acct") { f.failAfter = undefined; throw new Error("timeout-after-effect"); }
      return { ref: accounts.get(a.key)!, created: !had };
    },
    async ensureDid(a) {
      calls.push("did");
      if (f.failBefore === "did") { f.failBefore = undefined; throw new Error("timeout"); }
      const had = dids.has(a.key); if (!had) dids.set(a.key, `did-${dids.size + 1}`);
      if (f.failAfter === "did") { f.failAfter = undefined; throw new Error("timeout-after-effect"); }
      return { ref: dids.get(a.key)!, created: !had };
    },
    async ensureDestination(a) {
      calls.push("dest");
      if (f.failBefore === "dest") { f.failBefore = undefined; throw new Error("timeout"); }
      const had = routes.has(a.key);
      if (!had) routes.set(a.key, { didRef: a.didRef, target: "trunk" in a.target ? `${a.target.trunk}/${a.target.ext}` : `agent:${a.target.agentRef}` });
      if (f.failAfter === "dest") { f.failAfter = undefined; throw new Error("timeout-after-effect"); }
      return { ref: `route-${[...routes.keys()].indexOf(a.key) + 1}`, created: !had };
    },
    async readBack(a) {
      calls.push("readback");
      if (f.readBackThrows) throw new Error("down");
      const r = [...routes.values()].find((x) => x.didRef === a.didRef);
      return { didActive: true, destination: r ? { target: f.mismatch ? "something/else" : r.target, active: true } : null };
    },
  };
  // Anything outside the interface (charge, invoice, delete, reset ...) is a defect: it throws.
  const prov = new Proxy(impl, { get(t, p) { if (typeof p === "string" && !allowed.has(p)) return () => { throw new Error(`forbidden provisioner operation: ${p}`); }; return (t as never)[p]; } }) as Provisioner & Record<string, () => never>;
  return { prov, calls, accounts, dids, routes, faults: f };
}

function fakeLedger(opts: { failRecordOnce?: AttachStepName } = {}) {
  const rows = new Map<string, AttachLedgerRecord>();
  const k = (w: string, p: string) => `${w}|${p}`;
  const o = { ...opts };
  const ledger: AttachLedger = {
    async get(w, p) { return rows.get(k(w, p)) ?? null; },
    async begin(a) {
      const cur = rows.get(k(a.workspaceId, a.phoneNumberId));
      if (cur && cur.leaseUntil && new Date(cur.leaseUntil) > a.now && cur.status === "in_progress") return false;
      rows.set(k(a.workspaceId, a.phoneNumberId), { idempotencyKey: a.idempotencyKey, destinationId: a.destinationId, steps: cur?.steps ?? {}, status: "in_progress", leaseUntil: new Date(a.now.getTime() + a.leaseMs).toISOString() });
      return true;
    },
    async recordStep(a) {
      if (o.failRecordOnce === a.step && a.rec.done) { o.failRecordOnce = undefined; throw new Error("ledger write lost"); }
      rows.get(k(a.workspaceId, a.phoneNumberId))!.steps[a.step] = a.rec;
    },
    async finish(a) { const r = rows.get(k(a.workspaceId, a.phoneNumberId))!; r.status = a.status; r.leaseUntil = null; },
  };
  return { ledger, rows, o };
}

const agents: AgentDirectory = { exists: async (ref, ws) => ref === "agent-fictional-1" && ws === WS_A };
const pre = (o: Partial<Preconditions> = {}): Preconditions => ({ connectionStatus: "active", claimants: [WS_A], selectable: [D_QUEUE, D_AGENT], ...o });
const NOW = new Date("2026-10-18T10:00:00Z");
const run = (h: { prov: Provisioner; led: ReturnType<typeof fakeLedger> }, over: { destinationId?: string; ws?: string; pre?: Preconditions } = {}) =>
  attachService({ workspaceId: over.ws ?? WS_A, phoneNumberId: PHONE, number: "15550100100", destinationId: over.destinationId ?? D_QUEUE.id, pre: over.pre ?? pre() }, { ledger: h.led.ledger, prov: h.prov, now: () => NOW });
const harness = (faults: Faults = {}, led: { failRecordOnce?: AttachStepName } = {}) => { const p = fakeProv(faults); return { ...p, led: fakeLedger(led) }; };
const counts = (h: ReturnType<typeof harness>) => [h.accounts.size, h.dids.size, h.routes.size];

describe("attachService", () => {
  test("positive control: a verified, connected number attaches to its chosen destination in four steps; one account, one DID, one route", async () => {
    const h = harness();
    const r = await run(h);
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls, ["acct", "did", "dest", "readback"]);
    assert.deepEqual(counts(h), [1, 1, 1]);
    assert.equal(h.led.rows.get(`${WS_A}|${PHONE}`)!.status, "attached");
  });

  test("idempotent: attaching again changes nothing and makes no provisioner call", async () => {
    const h = harness();
    await run(h);
    const before = h.calls.length;
    const r = await run(h);
    assert.deepEqual([r.ok, h.calls.length, counts(h)], [true, before, [1, 1, 1]]);
  });

  test("failure BEFORE an effect (DID step): reported as retriable, nothing duplicated; the retry resumes and does not redo the account", async () => {
    const h = harness({ failBefore: "did" });
    const r1 = await run(h);
    assert.deepEqual([r1.ok, !r1.ok && r1.code, !r1.ok && r1.step, !r1.ok && r1.retriable], [false, "step_failed", "did", true]);
    assert.deepEqual(counts(h), [1, 0, 0]);
    const r2 = await run(h);
    assert.equal(r2.ok, true);
    assert.equal(h.calls.filter((c) => c === "acct").length, 1, "the account step was not repeated");
    assert.deepEqual(counts(h), [1, 1, 1]);
  });

  test("AMBIGUOUS failure (the DID WAS created, the answer was lost): retry with the same key creates no second DID (twin: counts stay 1)", async () => {
    const h = harness({ failAfter: "did" });
    const r1 = await run(h);
    assert.equal(!r1.ok && r1.step, "did");
    assert.equal(h.dids.size, 1, "control: the effect really happened");
    const r2 = await run(h);
    assert.equal(r2.ok, true);
    assert.deepEqual(counts(h), [1, 1, 1]);
  });

  test("crash AFTER the effect but BEFORE the ledger write: the retry re-asks the provisioner, which returns the existing record; still one of each", async () => {
    const h = harness({}, { failRecordOnce: "destination" });
    const r1 = await run(h).catch(() => ({ ok: false as const }));
    assert.equal(h.routes.size, 1, "control: the route exists");
    assert.equal(r1.ok, false);
    const r2 = await run(h);
    assert.equal(r2.ok, true);
    assert.deepEqual(counts(h), [1, 1, 1]);
  });

  test("two concurrent attaches for the same number: exactly one runs, the other is told it is in progress; still one of each", async () => {
    const h = harness({ delayMs: 20 });
    const [a, b] = await Promise.all([run(h), run(h)]);
    const codes = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
    assert.deepEqual(codes, ["attach_in_progress", "ok"]);
    assert.deepEqual(counts(h), [1, 1, 1]);
  });

  test("read-back mismatch: NOT complete, state needs_review, nothing deleted or rolled back, and a retry does not call the provisioner again", async () => {
    const h = harness({ mismatch: true });
    const r = await run(h);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "needs_review"]);
    assert.deepEqual(counts(h), [1, 1, 1]);
    const before = h.calls.length;
    const r2 = await run(h);
    assert.deepEqual([!r2.ok && r2.code, h.calls.length], ["needs_review", before]);
  });

  test("an UNEXPIRED provisioner lease (an earlier attempt still finishing) is reported as retry_pending, not as a failure; the later retry completes", async () => {
    const h = harness(); const real = h.prov.ensureServiceAccount.bind(h.prov); let busy = true;
    const prov = { ...h.prov, ensureServiceAccount: async (a: Parameters<Provisioner["ensureServiceAccount"]>[0]) => { if (busy) { busy = false; throw Object.assign(new Error("provisioner 409 busy"), { code: "busy" }); } return real(a); } } as Provisioner;
    const r1 = await attachService({ workspaceId: WS_A, phoneNumberId: PHONE, number: "15550100100", destinationId: D_QUEUE.id, pre: pre() }, { ledger: h.led.ledger, prov, now: () => NOW });
    assert.deepEqual([r1.ok, !r1.ok && r1.code, !r1.ok && r1.retriable], [false, "retry_pending", true]);
    assert.match(!r1.ok ? r1.message : "", /has failed permanently/);
    assert.deepEqual(counts(h), [0, 0, 0]);
    const r2 = await attachService({ workspaceId: WS_A, phoneNumberId: PHONE, number: "15550100100", destinationId: D_QUEUE.id, pre: pre() }, { ledger: h.led.ledger, prov, now: () => NOW });
    assert.equal(r2.ok, true); // twin: a genuine failure is still step_failed (tests above)
  });

  test("read-back unavailable: step_failed (retriable), not 'attached'", async () => {
    const h = harness({ readBackThrows: true });
    const r = await run(h);
    assert.deepEqual([r.ok, !r.ok && r.code, !r.ok && r.step], [false, "step_failed", "read_back"]);
    assert.notEqual(h.led.rows.get(`${WS_A}|${PHONE}`)!.status, "attached");
  });

  test("preconditions come from SeldonFrame's own state: not connected / unfinished connection / failed connection are refused with zero provisioner calls (twin: active attaches)", async () => {
    for (const s of [null, "pending", "registering", "registered", "failed"] as const) {
      const h = harness();
      const r = await run(h, { pre: pre({ connectionStatus: s }) });
      assert.deepEqual([r.ok, !r.ok && r.code, h.calls.length], [false, "not_connected", 0], String(s));
    }
    assert.equal((await run(harness())).ok, true);
  });

  test("cross-workspace: a number held by another workspace (or by two) is refused; B cannot attach A's number or use A's destinations", async () => {
    const h = harness();
    assert.equal(!(await run(h, { pre: pre({ claimants: [WS_B] }) })).ok, true);
    assert.equal(!(await run(h, { pre: pre({ claimants: [WS_A, WS_B] }) })).ok, true);
    assert.equal(h.calls.length, 0);
    const forB = await run(h, { ws: WS_B, destinationId: D_OTHER.id, pre: pre({ claimants: [WS_A], selectable: [D_OTHER] }) });
    assert.deepEqual([forB.ok, !forB.ok && forB.code], [false, "number_not_yours"]);
    const stolen = await run(h, { destinationId: D_OTHER.id }); // A asks for B's destination: not in A's selectable list
    assert.deepEqual([stolen.ok, !stolen.ok && stolen.code, h.calls.length], [false, "destination_not_allowed", 0]);
  });

  test("changing the destination is NOT a retry: refused, no calls (twin: the same destination resumes)", async () => {
    const h = harness({ failBefore: "dest" });
    await run(h);
    const before = h.calls.length;
    const change = await run(h, { destinationId: D_AGENT.id });
    assert.deepEqual([!change.ok && change.code, h.calls.length], ["destination_change_requires_explicit_action", before]);
    assert.equal((await run(h)).ok, true);
  });

  test("NO CHARGE, NO DELETE: the provisioner interface has no such operation, and the fake throws if one is ever invoked (control: it does throw)", async () => {
    const h = harness();
    assert.equal((await run(h)).ok, true);
    assert.throws(() => (h.prov as unknown as Record<string, () => void>).chargeWallet(), /forbidden provisioner operation/);
    assert.throws(() => (h.prov as unknown as Record<string, () => void>).deleteRoute(), /forbidden provisioner operation/);
  });

  test("a voice agent destination attaches exactly like a PBX one (no separate runtime path)", async () => {
    const h = harness();
    const r = await run(h, { destinationId: D_AGENT.id });
    assert.equal(r.ok, true);
    assert.equal([...h.routes.values()][0].target, "agent:agent-fictional-1");
  });
});

describe("selectableDestinations", () => {
  const catalog: DestinationOption[] = [
    D_QUEUE, D_AGENT, D_OTHER,
    { ...D_QUEUE, id: "d-disabled", status: "disabled" },
    { id: "d-dangling", label: "Gone agent", kind: "voice_agent", target: { agentRef: "agent-missing" }, workspaceId: WS_A, status: "active" },
    { id: "d-shared", label: "Shared", kind: "pbx_extension", target: { trunk: "pbx-shared", ext: "100" }, workspaceId: "shared", status: "active" },
    { id: "d-empty", label: "Broken", kind: "pbx_queue", target: { trunk: "", ext: "" }, workspaceId: WS_A, status: "active" },
  ];
  test("offers only active options this workspace may use, with an existing agent; never another workspace's, a disabled, dangling or empty one", async () => {
    const a = (await selectableDestinations(catalog, WS_A, agents)).map((d) => d.id).sort();
    assert.deepEqual(a, ["d-agent-a", "d-queue-a", "d-shared"]);
    const b = (await selectableDestinations(catalog, WS_B, agents)).map((d) => d.id).sort();
    assert.deepEqual(b, ["d-queue-b", "d-shared"]);
  });
});
