// EPIC 2026-10-11 — Personal Line subscriber account slice (2a): data for the "Your Personal Line" portal card.
//
// SERVER-SIDE ONLY. The subject chain is: portal session (signed cookie, org + contact) -> external_identities row for
// THAT contact in THAT org -> pl_account_id -> a signed GET to the Personal Line service. No account or contact id ever
// comes from the browser.
//
// FAIL CLOSED: anything other than a well-formed answer for exactly the account we signed for renders as
// "we can't show your line right now" — never another account's data, never a guessed figure. A contact with no
// identity link gets no card at all.
import { and, eq } from "drizzle-orm";
import { PL_PROVIDER } from "./link";
import { readPlKey, signSummaryRequest, type PlKey } from "./signing";

export type PlSummary = {
  did: string;
  plan: string | null;
  planName: string | null;
  planEnd: string | null;
  minutesLeft: number | null;
  minutesIncluded: number | null;
  wallet: { currency: string; amount: string } | null;
  setupState: "registered" | "not_registered" | "unknown";
};

export type PlCard = { kind: "none" } | { kind: "error" } | { kind: "ok"; summary: PlSummary };

export interface CardDeps {
  findAccountForContact(orgId: string, contactId: string): Promise<string | null>;
  fetchSummary(accountId: string): Promise<unknown>;
}

const isNumOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** Strict shape check of the plsvc envelope; returns null for anything unexpected (including another account). */
export function parseSummaryEnvelope(body: unknown, expectedAccount: string): PlSummary | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "ok" || b.code !== "account_summary") return null;
  const d = b.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  if (d.account !== expectedAccount) return null;
  if (typeof d.did !== "string" || d.did.length === 0) return null;
  if (!isStrOrNull(d.plan) || !isStrOrNull(d.plan_name) || !isStrOrNull(d.plan_end)) return null;
  if (!isNumOrNull(d.minutes_left) || !isNumOrNull(d.minutes_included)) return null;
  if (!["registered", "not_registered", "unknown"].includes(d.setup_state as string)) return null;
  let wallet: PlSummary["wallet"] = null;
  if (d.wallet !== null) {
    const w = d.wallet as Record<string, unknown> | undefined;
    if (!w || typeof w.currency !== "string" || typeof w.amount !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(w.amount)) return null;
    wallet = { currency: w.currency, amount: w.amount };
  }
  return {
    did: d.did,
    plan: d.plan as string | null,
    planName: d.plan_name as string | null,
    planEnd: d.plan_end as string | null,
    minutesLeft: d.minutes_left as number | null,
    minutesIncluded: d.minutes_included as number | null,
    wallet,
    setupState: d.setup_state as PlSummary["setupState"],
  };
}

export async function loadPersonalLineCard(
  session: { orgId: string; contact: { id: string } },
  deps: CardDeps,
): Promise<PlCard> {
  let accountId: string | null;
  try {
    accountId = await deps.findAccountForContact(session.orgId, session.contact.id);
  } catch {
    return { kind: "error" };
  }
  if (!accountId) return { kind: "none" };
  try {
    const body = await deps.fetchSummary(accountId);
    const summary = parseSummaryEnvelope(body, accountId);
    return summary ? { kind: "ok", summary } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Signed GET to plsvc. Throws on anything but HTTP 200 (the caller turns every throw into the error card). */
export function makeSummaryFetcher(opts: {
  baseUrl: string | undefined;
  key: PlKey | null;
  fetchImpl?: typeof fetch;
  nowS?: () => number;
  timeoutMs?: number;
}) {
  return async (accountId: string): Promise<unknown> => {
    if (!opts.baseUrl || !/^https?:\/\//.test(opts.baseUrl) || !opts.key) throw new Error("pl_summary_not_configured");
    const ts = (opts.nowS ?? (() => Math.floor(Date.now() / 1000)))();
    const url = new URL("/api/internal/pl-concierge/v1/account/summary", opts.baseUrl);
    url.searchParams.set("account", accountId);
    const res = await (opts.fetchImpl ?? fetch)(url.toString(), {
      method: "GET",
      headers: {
        "x-pl-sf-kid": opts.key.kid,
        "x-pl-sf-ts": String(ts),
        "x-pl-sf-sig": signSummaryRequest(opts.key.key, ts, accountId),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (res.status !== 200) throw new Error(`pl_summary_http_${res.status}`);
    return res.json();
  };
}

/** The production deps: drizzle identity lookup + the signed fetcher (PL_SUMMARY_BASE_URL, PL_SF_SUMMARY_KEY_FILE/_ID). */
export async function productionCardDeps(env: Record<string, string | undefined> = process.env): Promise<CardDeps> {
  const { db } = await import("@/db");
  const { externalIdentities } = await import("@/db/schema");
  const key = await readPlKey("PL_SF_SUMMARY_KEY_FILE", "PL_SF_SUMMARY_KEY_ID", env);
  const plOrgId = env.PL_SF_ORG_ID?.trim() || null;
  return {
    async findAccountForContact(orgId, contactId) {
      // Only the pinned Personal Line workspace can hold links (the ingress writes nowhere else). Every other workspace
      // — and every workspace while PL_SF_ORG_ID is unset — gets no card and no query, so this feature can never put an
      // error card in front of an unrelated business's customers.
      if (!plOrgId || orgId !== plOrgId) return null;
      const [row] = await db
        .select({ externalId: externalIdentities.externalId })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.orgId, orgId), eq(externalIdentities.provider, PL_PROVIDER), eq(externalIdentities.contactId, contactId)))
        .limit(1);
      return row?.externalId ?? null;
    },
    fetchSummary: makeSummaryFetcher({ baseUrl: env.PL_SUMMARY_BASE_URL?.trim(), key }),
  };
}
