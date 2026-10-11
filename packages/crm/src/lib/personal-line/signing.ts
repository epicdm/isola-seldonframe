// EPIC 2026-10-11 — Personal Line subscriber account slice (2a): the two server-to-server signatures.
//
// INGRESS (plsvc -> SeldonFrame, POST /api/webhooks/personal-line/[orgId]):
//   X-PL-SF-Kid: <kid>  X-PL-SF-Ts: <unix s>  X-PL-SF-Sig: base64url(HMAC-SHA256(events key, "<ts>.<raw body>"))
//   ±300 s; everything else refused. Key = the workspace's "personal-line-events" secret (workspace_secrets).
//
// EGRESS (SeldonFrame -> plsvc, GET /api/internal/pl-concierge/v1/account/summary?account=<id>):
//   same three headers, MAC = base64url(HMAC-SHA256(summary key, "pl-sf-summary-v1.<ts>.<account>")) — the exact
//   counterpart of isolav2 app/lib/pl-concierge/sf-summary.ts. Key = the workspace's "personal-line-summary" secret.
//
// Two keys on purpose: one per direction, so holding the read key can never forge a link and vice versa.
// Same family as lib/agents/mcp/relay-context.ts: >= 32-byte keys, no whitespace, constant-time compare, a kid.
import { createHmac, timingSafeEqual } from "node:crypto";

export const PL_SKEW_S = 300;
export const SUMMARY_SIG_LABEL = "pl-sf-summary-v1";
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

export function signSummaryRequest(key: string, ts: number, account: string): string {
  return mac(key, `${SUMMARY_SIG_LABEL}.${ts}.${account}`);
}

export const PORTAL_LINK_SIG_LABEL = "pl-sf-portal-link-v1";

/** R1 S-c: the portal-link request MAC is domain-separated from the event ingress MAC, so a captured event signature can
 *  never be replayed as a portal-link request (or the reverse) even though both use the workspace events key. */
export function signPortalLinkRequest(key: string, ts: number, rawBody: string): string {
  return mac(key, `${PORTAL_LINK_SIG_LABEL}.${ts}.${rawBody}`);
}

export type IngressCheck =
  | { ok: true }
  | { ok: false; why: "unsigned" | "malformed" | "unknown_kid" | "bad_signature" | "expired" | "not_configured" };

/** PURE. The signature is checked before freshness, so an unsigned caller learns nothing about the window. */
export function verifyIngress(headers: { get(name: string): string | null }, rawBody: string, key: PlKey | null, nowS: number): IngressCheck {
  return verifySigned(headers, rawBody, key, nowS, signIngress);
}

export function verifyPortalLinkRequest(headers: { get(name: string): string | null }, rawBody: string, key: PlKey | null, nowS: number): IngressCheck {
  return verifySigned(headers, rawBody, key, nowS, signPortalLinkRequest);
}

function verifySigned(
  headers: { get(name: string): string | null },
  rawBody: string,
  key: PlKey | null,
  nowS: number,
  macOf: (key: string, ts: number, rawBody: string) => string,
): IngressCheck {
  if (!key) return { ok: false, why: "not_configured" };
  const kid = headers.get("x-pl-sf-kid");
  const tsRaw = headers.get("x-pl-sf-ts");
  const sig = headers.get("x-pl-sf-sig");
  if (!kid || !tsRaw || !sig) return { ok: false, why: "unsigned" };
  if (!/^\d{9,11}$/.test(tsRaw) || !SIG.test(sig)) return { ok: false, why: "malformed" };
  if (kid !== key.kid) return { ok: false, why: "unknown_kid" };
  const ts = Number(tsRaw);
  if (!macMatches(macOf(key.key, ts, rawBody), sig)) return { ok: false, why: "bad_signature" };
  if (Math.abs(nowS - ts) > PL_SKEW_S) return { ok: false, why: "expired" };
  return { ok: true };
}
