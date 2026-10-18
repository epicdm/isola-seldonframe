// The service increment's use cases, over injected dependencies (so they are tested without a database). Every function receives the workspace id and actor
// FROM THE SERVER SESSION (or, for service-to-service events, derives the workspace from the number's verified binding); nothing here reads a workspace id from a
// request body. The four states are computed separately and never collapsed.
import { evaluateAcceptance, type Attestation, type CdrFact, type MetaCallEvent, type RoutingFact } from "./acceptance";
import { attachService, targetString, type AttachLedger, type AttachLedgerRecord, type AttachResult, type Provisioner } from "./attach";
import { selectableDestinations, type AgentDirectory, type DestinationOption } from "./destinations";
import { deriveServiceStates, type ServiceStates } from "./states";
import type { LineEvidence } from "../types";

export type StoredAttestation = Attestation & { evidence: { callId: string; cdrStartedAt: string; billedSeconds: number; routingVerifiedAt: string; routedTarget: string } };

export type ServiceDeps = {
  now(): Date;
  connectionStatus(ws: string, phone: string): Promise<"pending" | "registering" | "registered" | "active" | "failed" | null>;
  claimants(phone: string): Promise<string[]>;
  line(ws: string, phone: string): Promise<{ wabaId: string } | null>;
  catalog(ws: string): Promise<DestinationOption[]>;
  agents: AgentDirectory;
  ledger: AttachLedger;
  evidence(line: { wabaId: string; phoneNumberId: string }): Promise<LineEvidence | null>;
  provisioner(ws: string, phone: string): Provisioner;
  callEvents(ws: string, phone: string): Promise<MetaCallEvent[]>;
  appendCallEvent(ws: string, phone: string, ev: MetaCallEvent): Promise<void>;
  acceptance(ws: string, phone: string): Promise<StoredAttestation[]>;
  appendAcceptance(ws: string, phone: string, a: StoredAttestation): Promise<void>;
};

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
export const versionOf = (d: DestinationOption) => `${d.id}@${targetString(d)}`;

type Facts = {
  ledger: AttachLedgerRecord | null; dest: DestinationOption | null; evidence: LineEvidence | null;
  routing: { didActive: boolean; destinationActive: boolean; destinationTarget: string | null } | null; cdrs: CdrFact[];
  routingVerifiedAt: string | null; number: string | null;
};

async function gather(ws: string, phone: string, deps: ServiceDeps): Promise<Facts> {
  const [ledger, line, catalog] = await Promise.all([deps.ledger.get(ws, phone), deps.line(ws, phone), deps.catalog(ws)]);
  const dest = ledger ? catalog.find((d) => d.id === ledger.destinationId) ?? null : null;
  const evidence = line ? await deps.evidence({ wabaId: line.wabaId, phoneNumberId: phone }).catch(() => null) : null;
  let routing: Facts["routing"] = null; let cdrs: CdrFact[] = [];
  if (evidence?.magnus.ok) {
    const m = evidence.magnus;
    routing = { didActive: !!m.did?.activated, destinationActive: !!m.destination?.activated, destinationTarget: m.destination?.value ?? null };
    cdrs = m.lastCalls.map((c) => ({ answered: c.answered, billedSeconds: c.durationSec, startedAt: c.startedAt ?? "", calledNumberMatchesLine: true }));
  }
  const number = evidence?.meta.ok ? digits(evidence.meta.displayNumber) || null : null;
  return { ledger, dest, evidence, routing, cdrs, routingVerifiedAt: ledger?.steps.read_back?.done ? ledger.steps.read_back.at ?? null : null, number };
}

function acceptanceInput(ws: string, phone: string, f: Facts, events: MetaCallEvent[], atts: Attestation[]) {
  const expectedTarget = f.dest ? targetString(f.dest) : "";
  const routing: RoutingFact | null = f.routing && f.routingVerifiedAt
    ? { didActive: f.routing.didActive, destinationActive: f.routing.destinationActive, destinationTarget: f.routing.destinationTarget, observedAt: f.routingVerifiedAt } : null;
  return { workspaceId: ws, phoneNumberId: phone, expectedTarget, destinationVersion: f.dest ? versionOf(f.dest) : "", routing, metaEvents: events, cdrs: f.cdrs, attestations: atts };
}

export type ServiceView = {
  states: ServiceStates;
  selectable: Array<{ id: string; label: string; kind: string }>;
  current: { destinationId: string; label: string; version: string } | null;
  acceptance: { current: StoredAttestation[]; historical: Array<StoredAttestation & { why: string }> };
  missing: string[];
};

export async function serviceView(ws: string, phone: string, deps: ServiceDeps): Promise<ServiceView> {
  const f = await gather(ws, phone, deps);
  const [status, events, stored, catalog] = await Promise.all([deps.connectionStatus(ws, phone), deps.callEvents(ws, phone), deps.acceptance(ws, phone), deps.catalog(ws)]);
  const version = f.dest ? versionOf(f.dest) : null;
  const input = acceptanceInput(ws, phone, f, events, stored);
  const ev = evaluateAcceptance(input);
  const states = deriveServiceStates({ connectionStatus: status, ledger: f.ledger, routing: f.routing, expectedTarget: f.dest ? targetString(f.dest) : null, acceptance: ev.state });
  const current = stored.filter((a) => version && a.destinationVersion === version && states.routing === "verified");
  const historical = stored.filter((a) => !current.includes(a)).map((a) => ({
    ...a, why: version && a.destinationVersion === version ? "routing is not currently verified for this destination" : "accepted for an earlier route; it is not proof for the current route",
  }));
  const selectable = (await selectableDestinations(catalog, ws, deps.agents)).map(({ id, label, kind }) => ({ id, label, kind }));
  return { states, selectable, current: f.dest ? { destinationId: f.dest.id, label: f.dest.label, version: versionOf(f.dest) } : null, acceptance: { current, historical }, missing: states.acceptance === "not_applicable" ? [] : ev.missing };
}

export async function attach(ws: string, phone: string, destinationId: string, deps: ServiceDeps): Promise<AttachResult> {
  const f = await gather(ws, phone, deps);
  const [status, claimants, catalog] = await Promise.all([deps.connectionStatus(ws, phone), deps.claimants(phone), deps.catalog(ws)]);
  const selectable = await selectableDestinations(catalog, ws, deps.agents);
  if (!f.number) return { ok: false, code: "step_failed", retriable: true, message: "The number could not be confirmed with Meta just now. Nothing was changed; try again shortly." };
  return attachService(
    { workspaceId: ws, phoneNumberId: phone, number: f.number, destinationId, pre: { connectionStatus: status, claimants, selectable } },
    { ledger: deps.ledger, prov: deps.provisioner(ws, phone), now: () => deps.now() },
  );
}

export type AcceptResult = { ok: true; state: "accepted" | "failed" } | { ok: false; code: "not_your_number" | "forbidden" | "evidence_missing" | "not_set_up"; missing: string[] };

export async function recordAcceptance(ws: string, phone: string, actor: { userId: string; role: string }, twoWayAudio: boolean, deps: ServiceDeps): Promise<AcceptResult> {
  if (!["owner", "admin"].includes(actor.role)) return { ok: false, code: "forbidden", missing: [] };
  const claimants = await deps.claimants(phone);
  if (claimants.length !== 1 || claimants[0] !== ws) return { ok: false, code: "not_your_number", missing: [] };
  const f = await gather(ws, phone, deps);
  if (!f.dest || f.ledger?.status !== "attached") return { ok: false, code: "not_set_up", missing: ["calling service set up"] };
  const events = await deps.callEvents(ws, phone);
  const now = deps.now().toISOString();
  const candidate: Attestation = { userId: actor.userId, role: actor.role, workspaceId: ws, at: now, twoWayAudio, destinationVersion: versionOf(f.dest) };
  const r = evaluateAcceptance(acceptanceInput(ws, phone, f, events, [candidate]));
  if (r.state !== "accepted" && r.state !== "failed") return { ok: false, code: "evidence_missing", missing: r.missing };
  // The statement is stored WITH the evidence it rests on, so it can be explained later even after the route changes.
  const e = events.filter((x) => x.phoneNumberId === phone).at(-1)!;
  const cdr = f.cdrs.filter((c) => c.answered).at(-1)!;
  await deps.appendAcceptance(ws, phone, { ...candidate, evidence: { callId: e.callId, cdrStartedAt: cdr.startedAt, billedSeconds: cdr.billedSeconds, routingVerifiedAt: f.routingVerifiedAt!, routedTarget: f.routing!.destinationTarget! } });
  return { ok: true, state: r.state };
}

/** Service-to-service: a Meta calling event captured by the BFF. The workspace is DERIVED from the number's verified binding; an unbound or contested number is dropped. */
export async function ingestCallEvent(phone: string, callId: string, atIso: string, deps: ServiceDeps): Promise<{ ok: boolean; reason?: string }> {
  const claimants = await deps.claimants(phone);
  if (claimants.length !== 1) return { ok: false, reason: claimants.length === 0 ? "unbound_number" : "conflicting_binding" };
  if (!callId || Number.isNaN(new Date(atIso).getTime())) return { ok: false, reason: "bad_event" };
  const ws = claimants[0];
  const existing = await deps.callEvents(ws, phone);
  if (existing.some((e) => e.callId === callId)) return { ok: true, reason: "duplicate_ignored" };
  await deps.appendCallEvent(ws, phone, { callId, phoneNumberId: phone, at: atIso });
  return { ok: true };
}
