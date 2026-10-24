// EPIC 2026-10-21 — the plsvc -> Uplink ingress signature. REUSED byte-for-byte from the 2026-10-11 account slice
// (isola-seldonframe#12 lib/personal-line/signing.ts, contract ops/personal-line/specs/pl-journey-events-contract-v1.md);
// the summary (egress) signer of that slice is not part of this change.
//
//   X-PL-SF-Kid: <kid>  X-PL-SF-Ts: <unix s>  X-PL-SF-Sig: base64url(HMAC-SHA256(key, "<ts>.<raw body>"))
//   ±300 s; everything else refused. The signature is checked before freshness, so an unsigned caller learns nothing.
// Same family as lib/agents/mcp/relay-context.ts: >= 32-byte keys, no whitespace, constant-time compare, a kid.
import { createHmac, timingSafeEqual } from "node:crypto";

export const PL_SKEW_S = 300;
const SIG = /^[A-Za-z0-9_-]{43}$/;

export type PlKey = { kid: string; key: string };

function mac(key: string, message: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(message, "utf8").digest("base64url");
}

function macMatches(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signIngress(key: string, ts: number, rawBody: string): string {
  return mac(key, `${ts}.${rawBody}`);
}

export type IngressCheck =
  | { ok: true }
  | { ok: false; why: "unsigned" | "malformed" | "unknown_kid" | "bad_signature" | "expired" | "not_configured" };

/** PURE. */
export function verifyIngress(
  headers: { get(name: string): string | null },
  rawBody: string,
  key: PlKey | null,
  nowS: number,
): IngressCheck {
  if (!key) return { ok: false, why: "not_configured" };
  const kid = headers.get("x-pl-sf-kid");
  const tsRaw = headers.get("x-pl-sf-ts");
  const sig = headers.get("x-pl-sf-sig");
  if (!kid || !tsRaw || !sig) return { ok: false, why: "unsigned" };
  if (!/^\d{9,11}$/.test(tsRaw) || !SIG.test(sig)) return { ok: false, why: "malformed" };
  if (kid !== key.kid) return { ok: false, why: "unknown_kid" };
  const ts = Number(tsRaw);
  if (!macMatches(signIngress(key.key, ts, rawBody), sig)) return { ok: false, why: "bad_signature" };
  if (Math.abs(nowS - ts) > PL_SKEW_S) return { ok: false, why: "expired" };
  return { ok: true };
}
