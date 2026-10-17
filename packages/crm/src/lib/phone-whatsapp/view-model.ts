// Turns evidence facts into what the customer sees. PURE: no I/O, no clock except the injected one.
//
// Rules this file exists to enforce (each has a test):
//   1. Missing or failed evidence is "unknown" and shows the actual failure. It is never rendered as ok.
//   2. A label such as status CONNECTED does not make a number eligible for calling, and a configured route is not a
//      working route. Eligibility is a list of explicit checks; routing is "proven" only by an answered call record.
//   3. Every fact carries the time it was observed and where it came from.
import type {
  CallingFacts,
  EligibilityCheck,
  EvidenceResult,
  Fact,
  LineLink,
  LineView,
  MagnusFacts,
  MetaFacts,
  Tone,
} from "./types";

export type ViewOptions = {
  now: Date;
  /** The SIP host Meta must be pointed at for calls to reach our voice switch (e.g. voice.epic.dm). Optional. */
  expectedSipHost?: string | null;
  /** An answered call older than this does not count as proof of routing. */
  proofWindowDays?: number;
};

const TIER_OK = new Set(["TIER_2K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED"]);
const TIER_LOW = new Set(["TIER_50", "TIER_250", "TIER_1K"]);

const unknownFact = (detail: string, source: string, headline = "Unknown"): Fact => ({ tone: "unknown", headline, detail, observedAt: null, source });

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown time";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 2) return "just now";
  if (m < 120) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function connectionFact(meta: MetaFacts, observedAt: string): Fact {
  const source = "Meta WhatsApp Business API";
  if (!meta.ok) return { ...unknownFact(meta.error, source, "Could not read this number from Meta"), observedAt: null };
  const bits = [`code verification: ${meta.codeVerification ?? "not reported"}`, `quality: ${meta.quality ?? "not reported"}`, `display name: ${meta.nameStatus ?? "not reported"}`].join("; ");
  // "Connected" is Meta's own word for the number's connection status. Code verification is shown as a detail, not a gate: a
  // registered number reports EXPIRED once its original code lapses (measured live on EPIC's numbers) while still CONNECTED.
  if (meta.status === "CONNECTED") return { tone: "ok", headline: "Connected", detail: bits, observedAt, source };
  if (!meta.status) return { tone: "unknown", headline: "Meta did not report a status", detail: bits, observedAt, source };
  return { tone: "attention", headline: `Meta reports ${meta.status}`, detail: bits, observedAt, source };
}

function checksFor(meta: MetaFacts, calling: CallingFacts): EligibilityCheck[] {
  const checks: EligibilityCheck[] = [];
  const metaErr = meta.ok ? null : meta.error;
  const callErr = calling.ok ? null : calling.error;
  checks.push({
    name: "Number is on this WhatsApp business account",
    tone: meta.ok ? "ok" : "unknown",
    detail: meta.ok ? "Confirmed at Meta." : `Not confirmed: ${metaErr}`,
  });
  const pt = meta.ok ? meta.platformType : null;
  checks.push({
    name: "Cloud API number (not the WhatsApp Business app)",
    tone: !meta.ok || !pt ? "unknown" : pt === "CLOUD_API" ? "ok" : "attention",
    detail: !meta.ok ? `Not read: ${metaErr}` : !pt ? `Meta did not report the platform${meta.extraFieldsError ? ` (${meta.extraFieldsError})` : ""}.` : `Platform: ${pt}.`,
  });
  const tier = meta.ok ? meta.messagingLimitTier : null;
  checks.push({
    name: "Messaging limit of at least 2,000 business-initiated chats per 24 h",
    tone: !meta.ok || !tier ? "unknown" : TIER_OK.has(tier) ? "ok" : TIER_LOW.has(tier) ? "attention" : "unknown",
    detail: !meta.ok ? `Not read: ${metaErr}` : !tier ? "Meta did not report a messaging limit." : `Tier: ${tier}${!TIER_OK.has(tier) && !TIER_LOW.has(tier) ? " (not a tier this page recognises)" : ""}.`,
  });
  checks.push({
    name: "WhatsApp calling is enabled at Meta",
    tone: !calling.ok ? "unknown" : calling.status === "ENABLED" ? "ok" : "attention",
    detail: !calling.ok ? `Not read: ${callErr}` : `Calling status: ${calling.status ?? "not reported"}.`,
  });
  checks.push({
    name: "SIP calling is configured",
    tone: !calling.ok ? "unknown" : calling.sipStatus === "ENABLED" && calling.sipHost ? "ok" : "attention",
    detail: !calling.ok ? `Not read: ${callErr}` : calling.sipHost ? `SIP ${calling.sipStatus ?? "status not reported"}, server ${calling.sipHost}${calling.sipPort ? `:${calling.sipPort}` : ""}.` : `SIP status: ${calling.sipStatus ?? "not configured"}; no SIP server set.`,
  });
  const h = meta.ok ? meta.canReceiveCallSip : null;
  checks.push({
    name: "Meta health: this number can receive SIP calls",
    tone: !meta.ok || !h ? "unknown" : h === "AVAILABLE" ? "ok" : "attention",
    detail: !meta.ok ? `Not read: ${metaErr}` : !h ? "Meta did not report this health signal." : `Meta health signal: ${h}.`,
  });
  return checks;
}

function eligibilityFact(meta: MetaFacts, calling: CallingFacts, observedAt: string): Fact & { checks: EligibilityCheck[] } {
  const checks = checksFor(meta, calling);
  const bad = checks.filter((c) => c.tone === "attention").length;
  const unk = checks.filter((c) => c.tone === "unknown").length;
  const source = "Meta WhatsApp Business API";
  if (bad) return { tone: "attention", headline: `Not eligible yet: ${bad} of ${checks.length} checks need attention`, detail: unk ? `${unk} more could not be confirmed.` : "Staff can fix these with you.", observedAt, source, checks };
  if (unk) return { tone: "unknown", headline: `Cannot confirm eligibility: ${unk} of ${checks.length} checks have no evidence`, detail: "No check has failed, but eligibility is not shown until every check is confirmed.", observedAt: meta.ok ? observedAt : null, source, checks };
  return { tone: "ok", headline: `Eligible: all ${checks.length} checks pass`, detail: "Every check above was read from Meta just now.", observedAt, source, checks };
}

function destinationFact(m: MagnusFacts, observedAt: string): Fact {
  const source = "EPIC voice platform (Magnus)";
  if (!m.ok) return unknownFact(m.error, source, "Could not read the call destination");
  if (!m.did) return { tone: "attention", headline: "No telephone routing record for this number", detail: "The voice platform has no entry for this number, so incoming calls have nowhere to go. EPIC staff set this up.", observedAt, source };
  if (!m.destination) return { tone: "attention", headline: "Number exists but has no destination", detail: "Staff must choose where calls to this number are delivered.", observedAt, source };
  const kind = m.destination.kind === "pjsip_trunk" ? "PBX or SIP trunk" : m.destination.kind === "sip_account" ? "SIP account" : "other destination type";
  if (!m.destination.activated) return { tone: "attention", headline: `Destination is switched off: ${m.destination.value}`, detail: `Type: ${kind}.`, observedAt, source };
  const multi = m.destination.count > 1 ? ` ${m.destination.count} destinations are configured; the first is shown.` : "";
  return { tone: "ok", headline: `Configured: ${m.destination.value}`, detail: `Type: ${kind}. This shows where calls are sent, not that the destination answers.${multi}`, observedAt, source };
}

function lastCallFact(m: MagnusFacts, observedAt: string, now: Date): Fact {
  const source = "EPIC voice platform call records";
  if (!m.ok) return unknownFact(m.error, source, "Could not read call records");
  const c = m.lastCalls[0];
  if (!c) return { tone: "unknown", headline: "No call record found for this number", detail: "The voice platform has no call record for this number. That means no call has been recorded, not that calls fail.", observedAt, source };
  const when = `${formatUtc(c.startedAt)}${c.startedAt ? ` (${ago(c.startedAt, now)})` : ""}`;
  const answered = m.lastCalls.find((x) => x.answered);
  const lastAnswered = answered ? `Last answered call: ${formatUtc(answered.startedAt)}, ${answered.durationSec} s.` : "None of the recent records was an answered call.";
  return {
    tone: c.answered ? "ok" : "attention",
    headline: `Last call ${when}: ${c.answered ? `answered, ${c.durationSec} s` : "not answered"}`,
    detail: `${lastAnswered} The record does not say whether the caller used WhatsApp or the phone network.`,
    observedAt,
    source,
  };
}

function routingFact(link: LineLink, calling: CallingFacts, magnus: MagnusFacts, observedAt: string, o: ViewOptions): Fact {
  const source = "Meta + EPIC voice platform";
  if (!calling.ok || !magnus.ok) {
    const missing = [!calling.ok ? "Meta calling settings" : null, !magnus.ok ? "voice platform records" : null].filter(Boolean).join(" and ");
    return unknownFact(`Routing cannot be assessed because ${missing} could not be read.`, source, "Cannot assess routing");
  }
  const problems: string[] = [];
  if (calling.sipStatus !== "ENABLED" || !calling.sipHost) problems.push("Meta is not configured to send SIP calls");
  else if (o.expectedSipHost && calling.sipHost !== o.expectedSipHost) problems.push(`Meta sends calls to ${calling.sipHost}, not ${o.expectedSipHost}`);
  if (!magnus.did) problems.push("the voice platform has no entry for this number");
  else if (!magnus.destination) problems.push("no destination is set");
  else if (!magnus.destination.activated) problems.push("the destination is switched off");
  if (problems.length) return { tone: "attention", headline: "Routing is not complete", detail: `${problems.join("; ")}.`, observedAt, source };
  const windowMs = (o.proofWindowDays ?? 30) * 86400000;
  const proof = magnus.lastCalls.find((c) => c.answered && c.startedAt && o.now.getTime() - new Date(c.startedAt).getTime() <= windowMs);
  if (proof) return { tone: "ok", headline: "Proven by a recent answered call", detail: `Configuration is complete and an answered call was recorded ${formatUtc(proof.startedAt)}. Records do not show the caller's channel, so run the acceptance call to prove WhatsApp specifically.`, observedAt, source };
  return { tone: "unknown", headline: "Configured, not yet proven", detail: `Configuration is complete, but no answered call is recorded in the last ${o.proofWindowDays ?? 30} days. Readiness is shown as proven only after a call is answered.`, observedAt, source };
}

const SOURCE_UNAVAILABLE = (result: EvidenceResult) =>
  result.kind === "not_configured"
    ? "The evidence service is not configured on this server, so nothing about this number can be confirmed."
    : result.kind === "failed"
      ? `The evidence service did not answer: ${result.error}`
      : "";

export function buildLineView(link: LineLink, result: EvidenceResult, o: ViewOptions): LineView {
  if (result.kind !== "evidence") {
    const why = SOURCE_UNAVAILABLE(result);
    const u = (name: string): Fact => unknownFact(why, "EPIC evidence service", name);
    return {
      phoneNumberId: link.phoneNumberId,
      label: link.label ?? null,
      displayNumber: null,
      verifiedName: null,
      connection: u("Cannot confirm the connection"),
      eligibility: { ...u("Cannot confirm calling eligibility"), checks: [] },
      destination: u("Cannot confirm the destination"),
      routing: u("Cannot assess routing"),
      lastCall: u("Cannot read call records"),
    };
  }
  const ev = result.evidence;
  return {
    phoneNumberId: link.phoneNumberId,
    label: link.label ?? null,
    displayNumber: ev.meta.ok ? ev.meta.displayNumber : null,
    verifiedName: ev.meta.ok ? ev.meta.verifiedName : null,
    connection: connectionFact(ev.meta, ev.observedAt),
    eligibility: eligibilityFact(ev.meta, ev.calling, ev.observedAt),
    destination: destinationFact(ev.magnus, ev.observedAt),
    routing: routingFact(link, ev.calling, ev.magnus, ev.observedAt, o),
    lastCall: lastCallFact(ev.magnus, ev.observedAt, o.now),
  };
}

export type { Tone };
