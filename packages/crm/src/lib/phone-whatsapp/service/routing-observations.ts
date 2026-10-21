// Routing HEALTH for a staff-linked number, from a RECORDED, DATED observation by EPIC staff. Uplink cannot measure the voice server (the evidence adapter
// reads only Magnus DID, destination and call records), so health is never inferred from Meta checks or from call records (which do not say whether a call
// came over WhatsApp). Sources, in order:
//   - an EPIC-staff observation for this workspace + number (PHONE_ROUTING_OBSERVATIONS_JSON, operator-set server configuration like the fixed
//     destinations: no tenant route, form or settings write can reach it);
//   - nothing recorded -> "not measured".
// An observation applies only while Magnus still shows the destination it was made for; after a route change it is not proof of anything.
// "verified" appears ONLY for a recorded passing WhatsApp acceptance call.

export type RoutingObservation = {
  workspaceId: string;
  phoneNumberId: string;
  /** ISO time of the observation (when staff looked, or when the acceptance call happened). */
  observedAt: string;
  /** Who/what recorded it, e.g. "Lane A trace". Shown to the customer. */
  source: string;
  /** The Magnus destination value the observation was made against, in the adapter's form ("PJSIP/<ext>@<trunk>"). */
  destination: string;
  result: "faults" | "configured_unverified" | "whatsapp_call_passed";
  /** result "faults": the observed faults, in plain words. */
  faults?: string[];
};

export type RoutingHealthState = "unknown" | "not_measured" | "configured_unverified" | "faults" | "verified";
export type RoutingHealth = { state: RoutingHealthState; text: string; observedAt: string | null; source: string | null };

const ISO_OK = (s: unknown) => typeof s === "string" && Number.isFinite(new Date(s).getTime());
const RESULTS = new Set(["faults", "configured_unverified", "whatsapp_call_passed"]);

/** The observations for exactly this workspace and number. Malformed config, malformed entries and other workspaces' entries are dropped (fail closed). */
export function routingObservationsFor(workspaceId: string, phoneNumberId: string, raw: string | null | undefined): RoutingObservation[] {
  let list: unknown;
  try { list = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((o): o is RoutingObservation => {
    if (typeof o !== "object" || o === null) return false;
    const r = o as Record<string, unknown>;
    if (r.workspaceId !== workspaceId || r.phoneNumberId !== phoneNumberId) return false;
    if (!ISO_OK(r.observedAt) || typeof r.source !== "string" || !r.source.trim() || typeof r.destination !== "string" || !r.destination) return false;
    if (typeof r.result !== "string" || !RESULTS.has(r.result)) return false;
    if (r.result === "faults" && (!Array.isArray(r.faults) || r.faults.length === 0 || !r.faults.every((f) => typeof f === "string" && f.trim()))) return false;
    return true;
  });
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function deriveRoutingHealth(i: {
  /** The Magnus destination value now (adapter form), or null when the voice platform could not be read / has no single destination. */
  currentDestination: string | null;
  /** false when the voice platform could not be read at all. */
  magnusRead: boolean;
  /** The voice platform reports an active DID and an active destination (measured live; absence is a fault Uplink CAN see). */
  routed: boolean;
  /** When the live voice-platform facts were read. */
  readAt: string | null;
  observations: RoutingObservation[];
  /** The injected clock: an observation dated after it has not happened yet and proves nothing (Codex review). */
  now: Date;
}): RoutingHealth {
  if (!i.magnusRead) return { state: "unknown", text: "Routing could not be checked right now", observedAt: null, source: null };
  if (!i.routed) return { state: "faults", text: "Not operational: the voice platform has no active destination for this number", observedAt: i.readAt, source: "EPIC voice platform (Magnus)" };
  const latest = i.observations.filter((o) => new Date(o.observedAt).getTime() <= i.now.getTime()).sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
  const notMeasured: RoutingHealth = { state: "not_measured", text: "Not measured: Uplink cannot see the voice server, and no EPIC check is recorded for the current route", observedAt: null, source: null };
  if (!latest || !i.currentDestination || latest.destination !== i.currentDestination) return notMeasured;
  const tail = `(observed ${day(latest.observedAt)}, ${latest.source.trim()})`;
  const base = { observedAt: new Date(latest.observedAt).toISOString(), source: latest.source.trim() }; // normalised to UTC before display (Codex review)
  if (latest.result === "faults") return { state: "faults", text: `Not operational: ${latest.faults!.map((f) => f.trim()).join("; ")} ${tail}`, ...base };
  if (latest.result === "whatsapp_call_passed") return { state: "verified", text: `A WhatsApp call to this number worked in both directions ${tail}`, ...base };
  return { state: "configured_unverified", text: `Configured; WhatsApp call not yet verified ${tail}`, ...base };
}
