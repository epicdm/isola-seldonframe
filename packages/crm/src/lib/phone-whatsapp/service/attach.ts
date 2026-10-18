// EPIC-managed calling, increment 2: the ATTACH operation (workspace's verified number -> its service account -> its chosen destination).
//
// This module is PURE orchestration over two injected ports, so it is tested with fictional fixtures and never touches Magnus, a PBX or a database:
//   - Provisioner: the PRIVILEGED EPIC-side service (a separate, narrowly scoped service; NOT the read-only evidence adapter, NOT SeldonFrame).
//     It exposes only idempotent "ensure" operations keyed by an idempotency key, and has NO billing operation at all (the interface cannot charge).
//   - AttachLedger: the workspace's own record of how far an attach got (settings.phoneWhatsapp.service[<phone id>]).
//
// Safety properties (each is a test):
//   * preconditions are checked from SeldonFrame's own verified state, never from the request: the number must be an ACTIVE connection of THIS workspace
//     and held by no other workspace; the destination must be an active catalog option this workspace is allowed to use;
//   * every step is idempotent by key and recorded; a retry resumes after the last recorded step; an ambiguous failure (the call may have happened) is
//     retried with the SAME key, so it cannot create a second account, DID, route or charge;
//   * two concurrent attaches for the same number cannot both run (ledger begin() is a compare-and-set with a lease);
//   * a read-back after the last step must match what was asked for, else the attach is NOT complete (state needs_review); nothing is rolled back
//     automatically and nothing is deleted;
//   * changing an existing destination is a separate explicit action, never a side effect of a retry.
import { createHash } from "node:crypto";

import type { DestinationOption } from "./destinations";

export type AttachStepName = "service_account" | "did" | "destination" | "read_back";
export const STEP_ORDER: AttachStepName[] = ["service_account", "did", "destination", "read_back"];

export type StepRecord = { done: boolean; ref?: string; at?: string; error?: string };
export type AttachLedgerRecord = {
  idempotencyKey: string;
  destinationId: string;
  steps: Partial<Record<AttachStepName, StepRecord>>;
  status: "in_progress" | "step_failed" | "needs_review" | "attached";
  leaseUntil: string | null;
};

export interface AttachLedger {
  get(workspaceId: string, phoneNumberId: string): Promise<AttachLedgerRecord | null>;
  /** Compare-and-set: returns false when another attach holds an unexpired lease for this number. Creates the record when absent. */
  begin(a: { workspaceId: string; phoneNumberId: string; idempotencyKey: string; destinationId: string; now: Date; leaseMs: number }): Promise<boolean>;
  recordStep(a: { workspaceId: string; phoneNumberId: string; step: AttachStepName; rec: StepRecord }): Promise<void>;
  finish(a: { workspaceId: string; phoneNumberId: string; status: AttachLedgerRecord["status"] }): Promise<void>;
}

export interface Provisioner {
  /** Each call is idempotent by `key`: repeating it returns the SAME ref with created:false. None of them can create a charge. */
  ensureServiceAccount(a: { key: string; workspaceId: string }): Promise<{ ref: string; created: boolean }>;
  ensureDid(a: { key: string; accountRef: string; phoneNumberId: string; number: string }): Promise<{ ref: string; created: boolean }>;
  ensureDestination(a: { key: string; didRef: string; target: DestinationOption["target"]; kind: DestinationOption["kind"] }): Promise<{ ref: string; created: boolean }>;
  readBack(a: { didRef: string }): Promise<{ didActive: boolean; destination: { target: string; active: boolean } | null }>;
}

export type Preconditions = {
  /** Workspace's connection record status for this number (settings.phoneWhatsapp.connections[phone].status). */
  connectionStatus: "pending" | "registering" | "registered" | "active" | "failed" | null;
  /** Workspaces holding this number (linked line or unfinished connection). */
  claimants: string[];
  /** The destination options this workspace may select (already filtered by destinations.selectableDestinations). */
  selectable: DestinationOption[];
};

export type AttachRefusal =
  | "not_connected" | "number_not_yours" | "destination_not_allowed" | "destination_change_requires_explicit_action"
  | "attach_in_progress" | "retry_pending" | "step_failed" | "needs_review" | "bad_input";
export type AttachResult =
  | { ok: true; resumed: boolean; refs: Partial<Record<AttachStepName, string>> }
  | { ok: false; code: AttachRefusal; step?: AttachStepName; retriable: boolean; message: string };

export const attachKey = (workspaceId: string, phoneNumberId: string, destinationId: string) =>
  createHash("sha256").update(`${workspaceId}|${phoneNumberId}|${destinationId}`).digest("hex").slice(0, 32);

const MESSAGES: Record<AttachRefusal, string> = {
  not_connected: "Connect the number to Meta first; service setup starts only from an active connection.",
  number_not_yours: "That number is not held by this workspace alone.",
  destination_not_allowed: "That destination is not available to this workspace.",
  destination_change_requires_explicit_action: "This number already has a destination. Changing it is a separate, explicit action.",
  attach_in_progress: "Setup for this number is already running. Nothing was started twice.",
  retry_pending: "An earlier setup attempt is still being finished. Nothing has failed permanently and nothing was duplicated; try again in about a minute.",
  step_failed: "Setup stopped part-way. Nothing was duplicated; you can retry and it will continue from where it stopped.",
  needs_review: "Setup finished its steps but the result did not match what was requested. Nothing was undone or deleted; EPIC will check it.",
  bad_input: "The request was incomplete.",
};
const refuse = (code: AttachRefusal, retriable: boolean, step?: AttachStepName): AttachResult => ({ ok: false, code, step, retriable, message: MESSAGES[code] });

export type AttachDeps = { ledger: AttachLedger; prov: Provisioner; now(): Date; leaseMs?: number };

export async function attachService(
  p: { workspaceId: string; phoneNumberId: string; /** The number Meta reports for this line (digits), taken from verified evidence, never from the request. */ number: string; destinationId: string; pre: Preconditions },
  deps: AttachDeps,
): Promise<AttachResult> {
  if (!p.workspaceId || !/^\d{5,20}$/.test(p.phoneNumberId) || !/^\d{7,15}$/.test(p.number) || !p.destinationId) return refuse("bad_input", false);

  // Preconditions come from SeldonFrame's own state, not from the caller.
  if (p.pre.connectionStatus !== "active") return refuse("not_connected", false);
  if (p.pre.claimants.length !== 1 || p.pre.claimants[0] !== p.workspaceId) return refuse("number_not_yours", false);
  const dest = p.pre.selectable.find((d) => d.id === p.destinationId);
  if (!dest) return refuse("destination_not_allowed", false);

  const key = attachKey(p.workspaceId, p.phoneNumberId, p.destinationId);
  const existing = await deps.ledger.get(p.workspaceId, p.phoneNumberId);
  // A different destination than the one already being attached is never a retry: it needs the separate, explicit change action.
  if (existing && existing.destinationId !== p.destinationId) return refuse("destination_change_requires_explicit_action", false);
  if (existing?.status === "attached") return { ok: true, resumed: true, refs: refsOf(existing) };
  if (existing?.status === "needs_review") return refuse("needs_review", false);

  const got = await deps.ledger.begin({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, idempotencyKey: key, destinationId: p.destinationId, now: deps.now(), leaseMs: deps.leaseMs ?? 120_000 });
  if (!got) return refuse("attach_in_progress", true);

  const rec = (await deps.ledger.get(p.workspaceId, p.phoneNumberId))!;
  const refs: Partial<Record<AttachStepName, string>> = refsOf(rec);
  const resumed = Object.values(rec.steps).some((s) => s?.done);
  const save = (step: AttachStepName, r: StepRecord) => deps.ledger.recordStep({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, step, rec: r });

  const run = async (step: AttachStepName, fn: () => Promise<string>): Promise<AttachResult | null> => {
    if (rec.steps[step]?.done) return null;
    try {
      const ref = await fn();
      refs[step] = ref;
      await save(step, { done: true, ref, at: deps.now().toISOString() });
      return null;
    } catch (e) {
      // The provisioner reports "busy" while an earlier attempt still holds its lease (e.g. a crashed process whose lease has not expired):
      // that is a PENDING retry, not a failure. Nothing was written by this call.
      if ((e as { code?: unknown } | null)?.code === "busy") {
        await deps.ledger.finish({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, status: "step_failed" }).catch(() => undefined);
        return refuse("retry_pending", true, step);
      }
      // The call MAY have happened. The retry uses the same key, so it cannot duplicate. Only the error class is kept.
      await save(step, { done: false, error: e instanceof Error ? e.name : "error", at: deps.now().toISOString() }).catch(() => undefined);
      await deps.ledger.finish({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, status: "step_failed" }).catch(() => undefined);
      return refuse("step_failed", true, step);
    }
  };

  let stop = await run("service_account", async () => (await deps.prov.ensureServiceAccount({ key: `${key}:acct`, workspaceId: p.workspaceId })).ref);
  if (stop) return stop;
  stop = await run("did", async () => (await deps.prov.ensureDid({ key: `${key}:did`, accountRef: refs.service_account!, phoneNumberId: p.phoneNumberId, number: p.number })).ref);
  if (stop) return stop;
  stop = await run("destination", async () => (await deps.prov.ensureDestination({ key: `${key}:dest`, didRef: refs.did!, target: dest.target, kind: dest.kind })).ref);
  if (stop) return stop;

  // Read back what actually exists; the attach is complete only if it matches the request.
  let matched = false;
  try {
    const rb = await deps.prov.readBack({ didRef: refs.did! });
    matched = rb.didActive && !!rb.destination && rb.destination.active && rb.destination.target === targetString(dest);
  } catch {
    await deps.ledger.finish({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, status: "step_failed" }).catch(() => undefined);
    return refuse("step_failed", true, "read_back");
  }
  if (!matched) {
    await save("read_back", { done: false, error: "mismatch", at: deps.now().toISOString() });
    await deps.ledger.finish({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, status: "needs_review" });
    return refuse("needs_review", false, "read_back");
  }
  await save("read_back", { done: true, at: deps.now().toISOString() });
  await deps.ledger.finish({ workspaceId: p.workspaceId, phoneNumberId: p.phoneNumberId, status: "attached" });
  return { ok: true, resumed, refs };
}

export const targetString = (d: DestinationOption) => ("trunk" in d.target ? `${d.target.trunk}/${d.target.ext}` : `agent:${d.target.agentRef}`);

function refsOf(r: AttachLedgerRecord): Partial<Record<AttachStepName, string>> {
  const out: Partial<Record<AttachStepName, string>> = {};
  for (const s of STEP_ORDER) if (r.steps[s]?.ref) out[s] = r.steps[s]!.ref;
  return out;
}
