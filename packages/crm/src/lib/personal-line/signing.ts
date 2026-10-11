// EPIC 2026-10-11 — Personal Line subscriber account slice (2a): the two server-to-server signatures.
//
// INGRESS (plsvc -> SeldonFrame, POST /api/v1/integrations/personal-line/link):
//   X-PL-SF-Kid: <kid>  X-PL-SF-Ts: <unix s>  X-PL-SF-Sig: base64url(HMAC-SHA256(PL_SF_EVENTS_KEY, "<ts>.<raw body>"))
//   ±300 s; everything else refused. Key from PL_SF_EVENTS_KEY_FILE (a Swarm secret file), kid PL_SF_EVENTS_KEY_ID.
//
// EGRESS (SeldonFrame -> plsvc, GET /api/internal/pl-concierge/v1/account/summary?account=<id>):
//   same three headers, MAC = base64url(HMAC-SHA256(PL_SF_SUMMARY_KEY, "pl-sf-summary-v1.<ts>.<account>")) — the exact
//   counterpart of isolav2 app/lib/pl-concierge/sf-summary.ts. Key from PL_SF_SUMMARY_KEY_FILE, kid PL_SF_SUMMARY_KEY_ID.
//
// Two keys on purpose: one per direction, so holding the read key can never forge a link and vice versa.
// Same family as lib/agents/mcp/relay-context.ts: >= 32-byte keys, no whitespace, constant-time compare, a kid.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PL_SKEW_S = 300;
export const SUMMARY_SIG_LABEL = "pl-sf-summary-v1";
const KEY_ID = /^[a-z0-9]{1,16}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

export type PlKey = { kid: string; key: string };

export async function readPlKey(
  fileVar: "PL_SF_EVENTS_KEY_FILE" | "PL_SF_SUMMARY_KEY_FILE",
  kidVar: "PL_SF_EVENTS_KEY_ID" | "PL_SF_SUMMARY_KEY_ID",
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<PlKey | null> {
  const path = env[fileVar]?.trim();
  const kid = env[kidVar]?.trim();
  if (!path || !kid || !KEY_ID.test(kid)) return null;
  try {
    const key = (await read(path)).replace(/\r?\n$/, "");
    if (Buffer.byteLength(key, "utf8") < 32 || /\s/.test(key)) return null;
    return { kid, key };
  } catch {
    return null;
  }
}

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

export type IngressCheck =
  | { ok: true }
  | { ok: false; why: "unsigned" | "malformed" | "unknown_kid" | "bad_signature" | "expired" | "not_configured" };

/** PURE. The signature is checked before freshness, so an unsigned caller learns nothing about the window. */
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
