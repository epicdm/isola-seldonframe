// Phone & WhatsApp (read-only): shared types.
//
// Two separate things live here and must never be confused:
//   - LineLink      WHO owns a number. Held server-side per workspace; set by EPIC staff. A phone number
//                   typed or sent by a browser is never an authorization.
//   - LineEvidence  WHAT is true about a number right now. Facts read by the evidence adapter from Meta and
//                   Magnus. Facts only: this module decides what they mean, and never from a label alone.

export type LineLink = {
  /** Meta WhatsApp Business Account id (digits). */
  wabaId: string;
  /** Meta phone-number id (digits). */
  phoneNumberId: string;
  /** Optional staff-written label shown to the customer. */
  label?: string;
};

type Failed = { ok: false; error: string };

export type MetaFacts =
  | {
      ok: true;
      displayNumber: string | null;
      verifiedName: string | null;
      status: string | null;
      codeVerification: string | null;
      quality: string | null;
      nameStatus: string | null;
      platformType: string | null;
      messagingLimitTier: string | null;
      canReceiveCallSip: string | null;
      extraFieldsError: string | null;
    }
  | Failed;

export type CallingFacts =
  | {
      ok: true;
      status: string | null;
      sipStatus: string | null;
      sipHost: string | null;
      sipPort: number | string | null;
      callIconVisibility: string | null;
    }
  | Failed;

export type MagnusFacts =
  | {
      ok: true;
      did: { activated: boolean; reserved: boolean } | null;
      destination: { value: string; kind: string; activated: boolean; count: number } | null;
      lastCalls: Array<{ startedAt: string | null; durationSec: number; answered: boolean; terminateCauseId: number | null }>;
      note?: string;
    }
  | Failed;

export type LineEvidence = {
  schema: "line-evidence/v1";
  wabaId: string;
  phoneNumberId: string;
  observedAt: string;
  meta: MetaFacts;
  calling: CallingFacts;
  magnus: MagnusFacts;
};

export type EvidenceResult =
  | { kind: "evidence"; evidence: LineEvidence }
  | { kind: "not_configured" }
  | { kind: "failed"; error: string };

export type Tone = "ok" | "attention" | "unknown";

export type Fact = {
  tone: Tone;
  headline: string;
  detail: string;
  /** ISO time the underlying evidence was observed, or null when there is none. */
  observedAt: string | null;
  source: string;
};

export type EligibilityCheck = { name: string; tone: Tone; detail: string };

export type LineView = {
  phoneNumberId: string;
  label: string | null;
  displayNumber: string | null;
  verifiedName: string | null;
  connection: Fact;
  eligibility: Fact & { checks: EligibilityCheck[] };
  destination: Fact;
  routing: Fact;
  lastCall: Fact;
};

export type PageView =
  | { kind: "no_link" }
  | { kind: "link_conflict" }
  | { kind: "lines"; lines: LineView[] };
