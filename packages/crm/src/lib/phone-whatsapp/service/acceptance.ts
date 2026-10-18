// EPIC-managed calling, increment 2: the ACCEPTANCE CALL and what evidence marks a service READY.
//
// "Ready" means a real person placed a real call through the real path and it worked in both directions. A new call record alone is NOT proof (a CDR can be
// created by a ringing-then-dropped call, a probe or a bot: the 3742 test required the owner's own two-way-audio statement). Evidence required, all of it,
// all newer than the routing verification and bound to the CURRENT destination version:
//   1. ROUTING VERIFIED  the read-only adapter shows the DID active and its destination active and equal to the destination requested in the attach;
//   2. META CALL EVENT   a Meta calling event for this phone number id (the WhatsApp side saw the call and connected it) with a call id;
//   3. PBX/MAGNUS CDR    an ANSWERED record for the same number, started within the match window of the Meta event, billed seconds >= the minimum;
//   4. HUMAN ATTESTATION an owner/admin of THIS workspace states two-way audio worked, recorded with user and time, after (2) and (3).
// Changing the destination invalidates earlier acceptance (it was acceptance of a different path).
export const MIN_BILLED_SECONDS = 10;
export const MATCH_WINDOW_MS = 60_000;

export type RoutingFact = { didActive: boolean; destinationActive: boolean; destinationTarget: string | null; observedAt: string };
export type MetaCallEvent = { callId: string; phoneNumberId: string; at: string };
export type CdrFact = { answered: boolean; billedSeconds: number; startedAt: string; calledNumberMatchesLine: boolean };
export type Attestation = { userId: string; role: string; workspaceId: string; at: string; twoWayAudio: boolean; destinationVersion: string };

export type AcceptanceInput = {
  workspaceId: string;
  phoneNumberId: string;
  expectedTarget: string;
  destinationVersion: string;
  routing: RoutingFact | null;
  metaEvents: MetaCallEvent[];
  cdrs: CdrFact[];
  attestations: Attestation[];
};

export type AcceptanceState = "not_recorded" | "routing_not_verified" | "call_seen_unconfirmed" | "accepted" | "failed";
export type AcceptanceResult = { state: AcceptanceState; missing: string[] };

const ms = (iso: string) => new Date(iso).getTime();

/** Every Meta call event (after routing was verified) that has an answered, long-enough call record for the same line inside the match window; newest last. */
export function pairedCalls(i: AcceptanceInput): Array<{ event: MetaCallEvent; cdr: CdrFact }> {
  if (!i.routing) return [];
  const routedAt = ms(i.routing.observedAt);
  const out: Array<{ event: MetaCallEvent; cdr: CdrFact }> = [];
  for (const e of i.metaEvents.filter((x) => x.phoneNumberId === i.phoneNumberId && ms(x.at) >= routedAt).sort((a, b) => ms(a.at) - ms(b.at))) {
    const cdr = i.cdrs.find((c) => c.answered && c.calledNumberMatchesLine && c.billedSeconds >= MIN_BILLED_SECONDS && Math.abs(ms(c.startedAt) - ms(e.at)) <= MATCH_WINDOW_MS);
    if (cdr) out.push({ event: e, cdr });
  }
  return out;
}

export function evaluateAcceptance(i: AcceptanceInput): AcceptanceResult {
  const r = i.routing;
  if (!r || !r.didActive || !r.destinationActive || r.destinationTarget !== i.expectedTarget) {
    return { state: "routing_not_verified", missing: ["routing verified for the requested destination"] };
  }
  const routedAt = ms(r.observedAt);
  const metas = i.metaEvents.filter((e) => e.phoneNumberId === i.phoneNumberId && ms(e.at) >= routedAt);
  if (metas.length === 0) return { state: "not_recorded", missing: ["a call placed after routing was verified (Meta call event)"] };

  // Pair each Meta event with an answered, long-enough CDR for the same line started inside the window.
  const paired = metas.filter((e) =>
    i.cdrs.some((c) => c.answered && c.calledNumberMatchesLine && c.billedSeconds >= MIN_BILLED_SECONDS && Math.abs(ms(c.startedAt) - ms(e.at)) <= MATCH_WINDOW_MS),
  );
  if (paired.length === 0) return { state: "call_seen_unconfirmed", missing: ["an answered call record of at least " + MIN_BILLED_SECONDS + " s matching the Meta call event"] };

  const lastPairedAt = Math.max(...paired.map((e) => ms(e.at)));
  const mine = i.attestations.filter((a) => a.workspaceId === i.workspaceId && ["owner", "admin"].includes(a.role) && a.destinationVersion === i.destinationVersion && ms(a.at) >= lastPairedAt);
  if (mine.some((a) => a.twoWayAudio === false)) return { state: "failed", missing: ["a successful acceptance call (the last attestation says audio failed)"] };
  if (!mine.some((a) => a.twoWayAudio === true)) return { state: "call_seen_unconfirmed", missing: ["an owner/admin statement that two-way audio worked, made after the call"] };
  return { state: "accepted", missing: [] };
}
