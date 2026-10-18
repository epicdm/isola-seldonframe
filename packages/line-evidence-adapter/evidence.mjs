// line-evidence adapter: READ-ONLY composition of the telecom facts about ONE WhatsApp business number.
//
// Sources reused (nothing is rebuilt): Meta Graph (phone number, WABA membership, calling settings) and the
// MagnusBilling REST API (did, diddestination, call = CDR). Every Magnus request is a `read` action; there is no write
// path in this file. Each source block reports ok:true with facts, or ok:false with the actual failure, so the caller can
// show "unknown" honestly. Nothing here infers readiness: it returns facts, the consumer decides what they mean.
//
// Contract: schema "line-evidence/v1" (see README.md). Pure functions with injected fetch/clock for tests.
import crypto from "node:crypto";

export const SCHEMA = "line-evidence/v1";
const DIGITS = /^\d{5,20}$/;

export function isId(v) { return typeof v === "string" && DIGITS.test(v); }

const errText = (e) => String(e?.message ?? e).replace(/access_token=[^&\s]+/gi, "access_token=<hidden>").slice(0, 220);

async function metaGet(cfg, path, fetchImpl) {
  const res = await fetchImpl(`${cfg.metaBase}/${path}`, {
    headers: { Authorization: `Bearer ${cfg.metaToken}` },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new Error(`Meta HTTP ${res.status}: ${body?.error?.message ?? "no detail"}`);
  if (body == null) throw new Error("Meta returned a non-JSON body");
  return body;
}

export async function readMeta(cfg, wabaId, phoneNumberId, fetchImpl = fetch) {
  const out = { meta: null, calling: null };
  // 1) the number must belong to the WABA it is linked under (a mislinked pair never reads as healthy)
  try {
    let url = `${wabaId}/phone_numbers?fields=id&limit=100`;
    let found = false;
    for (let page = 0; page < 5 && url && !found; page++) {
      const body = await metaGet(cfg, url, fetchImpl);
      found = (body.data ?? []).some((p) => String(p.id) === phoneNumberId);
      const next = body.paging?.next;
      url = next && next.startsWith(`${cfg.metaBase}/`) ? next.slice(cfg.metaBase.length + 1).replace(/([?&])access_token=[^&]*&?/i, "$1") : null;
    }
    if (!found) throw new Error("number is not on the linked WhatsApp business account");
    const base = await metaGet(cfg, `${phoneNumberId}?fields=id,display_phone_number,verified_name,name_status,quality_rating,status,code_verification_status`, fetchImpl);
    let extra = {};
    try { extra = await metaGet(cfg, `${phoneNumberId}?fields=platform_type,whatsapp_business_manager_messaging_limit,health_status`, fetchImpl); } catch (e) { extra = { _error: errText(e) }; }
    out.meta = {
      ok: true,
      displayNumber: base.display_phone_number ?? null,
      verifiedName: base.verified_name ?? null,
      status: base.status ?? null,
      codeVerification: base.code_verification_status ?? null,
      quality: base.quality_rating ?? null,
      nameStatus: base.name_status ?? null,
      platformType: extra.platform_type ?? null,
      // Verified live 2026-10-17: the limit is `whatsapp_business_manager_messaging_limit` (TIER_2K), and the per-number SIP health is
      // under health_status.entities[] where entity_type is PHONE_NUMBER and id is this number (not at the top level).
      messagingLimitTier: extra.whatsapp_business_manager_messaging_limit ?? extra.messaging_limit_tier ?? null,
      canReceiveCallSip: (() => {
        const e = (extra.health_status?.entities ?? []).find((x) => x?.entity_type === "PHONE_NUMBER" && String(x?.id) === phoneNumberId);
        return typeof e?.can_receive_call_sip === "string" ? e.can_receive_call_sip : null;
      })(),
      extraFieldsError: extra._error ?? null,
    };
  } catch (e) {
    out.meta = { ok: false, error: errText(e) };
    out.calling = { ok: false, error: "the number could not be confirmed at Meta" };
    return out;
  }
  // 2) calling / SIP settings
  try {
    const s = await metaGet(cfg, `${phoneNumberId}/settings?fields=calling`, fetchImpl);
    const c = s.calling ?? null;
    const server = c?.sip?.servers?.[0] ?? null;
    out.calling = {
      ok: true,
      status: c?.status ?? null,
      sipStatus: c?.sip?.status ?? null,
      sipHost: server?.hostname ?? null,
      sipPort: server?.port ?? null,
      callIconVisibility: c?.call_icon_visibility ?? null,
    };
  } catch (e) {
    out.calling = { ok: false, error: errText(e) };
  }
  return out;
}

// ---- Magnus (read only) -------------------------------------------------------------------------------------------
function phpUrlencode(s) {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/!/g, "%21").replace(/~/g, "%7E").replace(/\*/g, "%2A")
    .replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export async function magnusRead(cfg, module, filters, opts = {}, fetchImpl = fetch) {
  const params = { page: "1", start: "0", limit: String(opts.limit ?? 10) };
  if (opts.sort) params.sort = opts.sort;
  if (opts.dir) params.dir = opts.dir;
  params.filter = JSON.stringify(filters.map((f) => ({
    type: f.type ?? (/^\d+$/.test(f.value) ? "numeric" : "string"), field: f.field, value: f.value, comparison: "eq",
  })));
  const mt = process.hrtime();
  const nonce = mt[0].toString() + String(mt[1]).padStart(9, "0").slice(0, 6);
  // `action` is a constant: this client can only READ.
  const postData = Object.entries({ module, action: "read", nonce, ...params })
    .map(([k, v]) => phpUrlencode(k) + "=" + phpUrlencode(String(v))).join("&");
  const sign = crypto.createHmac("sha512", cfg.magnusSecret).update(postData).digest("hex");
  const res = await fetchImpl(`${cfg.magnusUrl}/index.php/${module}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Key: cfg.magnusKey, Sign: sign },
    body: postData,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Magnus invalid response (HTTP ${res.status})`); }
  if (json?.status === "error") throw new Error(`Magnus error: ${String(json.message ?? "").slice(0, 120)}`);
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  // Magnus has been seen returning the WHOLE table for a filter it did not honour: keep only exact matches.
  const want = new Map(filters.map((f) => [f.field, String(f.value)]));
  const exact = rows.filter((r) => [...want].every(([k, v]) => r?.[k] != null && String(r[k]) === v));
  return { rows: exact, dropped: rows.length - exact.length, total: Number(json?.count ?? rows.length) };
}

const toIso = (s) => {
  const d = new Date(String(s ?? "").replace(" ", "T") + "Z"); // pkg_cdr.starttime is UTC (measured by the bff, 2026-08-30)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

// A "source" answers three questions about one number. Two implementations exist: the Magnus REST API (restSource, signed `read`
// requests) and a database account that can only SELECT (magnus-sql.mjs). The shaping below is shared so both give identical facts.
export function restSource(cfg, fetchImpl = fetch) {
  return {
    did: async (did) => (await magnusRead(cfg, "did", [{ field: "did", value: did, type: "string" }], { limit: 5 }, fetchImpl)).rows,
    destinations: async (idDid) => (await magnusRead(cfg, "diddestination", [{ field: "id_did", value: String(idDid), type: "numeric" }], { limit: 5 }, fetchImpl)).rows,
    calls: async (did) => (await magnusRead(cfg, "call", [{ field: "calledstation", value: did, type: "string" }], { limit: 5, sort: "starttime", dir: "DESC" }, fetchImpl)).rows,
  };
}

// A WhatsApp number that is not itself a Magnus DID (e.g. a mobile) is routed on the voice platform through a DID row
// keyed "wa<number>", because Magnus treats any dialed number equal to a DID row as a call to that DID. Only that exact
// form is accepted, so an alias can never point one number at another number's records.
export const ingressKeyOk = (did, key) => key === did || key === `wa${did}`;

export async function readMagnusFrom(source, did, key = did) {
  if (!isId(did)) return { ok: false, error: "no display number to look up (Meta read failed)" };
  if (!ingressKeyOk(did, key)) return { ok: false, error: "voice-platform key does not belong to this number" };
  try {
    const didRows = await source.did(key);
    if (didRows.length > 1) throw new Error(`ambiguous: ${didRows.length} DID rows match`);
    const row = didRows[0] ?? null;
    let destination = null;
    if (row) {
      const destRows = await source.destinations(row.id);
      const first = destRows[0] ?? null;
      destination = first ? {
        value: String(first.destination ?? "").slice(0, 120),
        kind: /^PJSIP\//i.test(String(first.destination ?? "")) ? "pjsip_trunk" : (Number(first.id_sip) > 0 ? "sip_account" : "other"),
        activated: String(first.activated) === "1",
        count: destRows.length,
      } : null;
    }
    const callRows = await source.calls(key);
    return {
      ok: true,
      ...(key !== did ? { ingressKey: key } : {}),
      did: row ? { activated: String(row.activated) === "1", reserved: String(row.reserved) === "1" } : null,
      destination,
      lastCalls: callRows.map((c) => ({
        startedAt: toIso(c.starttime),
        durationSec: Number(c.sessiontime ?? 0),
        answered: Number(c.sessiontime ?? 0) > 0 && Number(c.terminatecauseid ?? 0) === 1,
        terminateCauseId: c.terminatecauseid != null ? Number(c.terminatecauseid) : null,
      })),
      note: "pkg_cdr rows whose called number is this number; the CDR does not say whether the caller used WhatsApp or the phone network",
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export const readMagnus = (cfg, did, fetchImpl = fetch) => readMagnusFrom(restSource(cfg, fetchImpl), did);

export async function collectLineEvidence(cfg, { wabaId, phoneNumberId }, fetchImpl = fetch, now = () => new Date()) {
  if (!isId(wabaId) || !isId(phoneNumberId)) throw Object.assign(new Error("invalid ids"), { code: "bad_request" });
  const { meta, calling } = await readMeta(cfg, wabaId, phoneNumberId, fetchImpl);
  const did = meta?.ok ? String(meta.displayNumber ?? "").replace(/\D/g, "") : "";
  const key = cfg.magnusDidAliases?.[did] ?? did;
  const magnus = cfg.magnusSource ? await readMagnusFrom(cfg.magnusSource, did, key) : await readMagnusFrom(restSource(cfg, fetchImpl), did, key);
  return { schema: SCHEMA, wabaId, phoneNumberId, observedAt: now().toISOString(), meta, calling, magnus };
}
