import type { EvidenceResult, LineEvidence, LineLink } from "../../../src/lib/phone-whatsapp/types";

export const NOW = new Date("2026-10-17T19:00:00.000Z");
export const WABA = "100000000000001";
export const PNID = "111222333444555";
export const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const LINK: LineLink = { wabaId: WABA, phoneNumberId: PNID, label: "Front desk" };

export function evidence(over: Partial<LineEvidence> = {}): LineEvidence {
  return {
    schema: "line-evidence/v1",
    wabaId: WABA,
    phoneNumberId: PNID,
    observedAt: "2026-10-17T18:59:50.000Z",
    meta: { ok: true, displayNumber: "+1 555-010-0001", verifiedName: "ACME", status: "CONNECTED", codeVerification: "VERIFIED", quality: "GREEN", nameStatus: "APPROVED", platformType: "CLOUD_API", messagingLimitTier: "TIER_2K", canReceiveCallSip: "AVAILABLE", extraFieldsError: null },
    calling: { ok: true, status: "ENABLED", sipStatus: "ENABLED", sipHost: "voice.example.test", sipPort: 5061, callIconVisibility: "DEFAULT" },
    magnus: {
      ok: true,
      did: { activated: true, reserved: true },
      destination: { value: "PJSIP/15550100001@pbx-trunk", kind: "pjsip_trunk", activated: true, count: 1 },
      lastCalls: [{ startedAt: "2026-10-17T12:57:27.000Z", durationSec: 3, answered: true, terminateCauseId: 1 }],
    },
    ...over,
  };
}

export const ok = (e: LineEvidence = evidence()): EvidenceResult => ({ kind: "evidence", evidence: e });
