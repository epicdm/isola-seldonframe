// HTTP client for the line-evidence adapter. Server-side only.
//
// The adapter holds the Meta and Magnus access; this app holds only a bearer token that can read ONE line's facts.
// Every failure is returned as a value with the actual reason, so the page can say "unknown: <why>". Nothing here throws
// into the page, and the token never appears in an error string.
import type { EvidenceResult, LineEvidence, LineLink } from "./types";

export type ProviderConfig = {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const isBlock = (b: unknown): b is { ok: boolean } => typeof b === "object" && b !== null && typeof (b as { ok?: unknown }).ok === "boolean";

export function validateEvidence(raw: unknown, link: LineLink): LineEvidence | string {
  if (typeof raw !== "object" || raw === null) return "the evidence service returned something that is not an object";
  const r = raw as Record<string, unknown>;
  if (r.schema !== "line-evidence/v1") return `unexpected evidence schema ${String(r.schema).slice(0, 40)}`;
  // A reply about a DIFFERENT line must never be shown as this line's facts.
  if (r.phoneNumberId !== link.phoneNumberId || r.wabaId !== link.wabaId) return "the evidence service answered for a different number than the one requested";
  if (typeof r.observedAt !== "string" || !Number.isFinite(new Date(r.observedAt).getTime())) return "the evidence has no valid observation time";
  if (!isBlock(r.meta) || !isBlock(r.calling) || !isBlock(r.magnus)) return "the evidence is missing one of its source blocks";
  return raw as LineEvidence;
}

export function makeEvidenceProvider(cfg: ProviderConfig) {
  return async (link: LineLink): Promise<EvidenceResult> => {
    if (!cfg.baseUrl || !cfg.token) return { kind: "not_configured" };
    let base: URL;
    try {
      base = new URL(cfg.baseUrl);
      if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("scheme");
    } catch {
      return { kind: "failed", error: "the evidence service address is not a valid http(s) URL" };
    }
    const url = `${base.origin}${base.pathname.replace(/\/$/, "")}/v1/lines/${encodeURIComponent(link.phoneNumberId)}?waba=${encodeURIComponent(link.wabaId)}`;
    try {
      const res = await (cfg.fetchImpl ?? fetch)(url, {
        headers: { authorization: `Bearer ${cfg.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 9000),
      });
      if (!res.ok) return { kind: "failed", error: `the evidence service answered HTTP ${res.status}` };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: "failed", error: "the evidence service answered with a body that is not JSON" };
      }
      const v = validateEvidence(body, link);
      return typeof v === "string" ? { kind: "failed", error: v } : { kind: "evidence", evidence: v };
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      return { kind: "failed", error: name === "TimeoutError" || name === "AbortError" ? "the evidence service did not answer in time" : "the evidence service could not be reached" };
    }
  };
}
