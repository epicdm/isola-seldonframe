// Standard Meta connection: production wiring (server-only). Database access and env live here; the logic is in ./finalize and ./verify-assets.
//
// Storage (all on the workspace's own organizations row, so a connected workspace is read by the SAME path the panel already uses):
//   settings.phoneWhatsapp.pending[<nonce hash>]      single-use attempt: { userId, expiresAt, consent }. RETENTION: expired entries are pruned and
//                                                     at most MAX_LIVE_ATTEMPTS kept, on every start. A consumed attempt is deleted and its consent
//                                                     moves into the connection record below.
//   settings.phoneWhatsapp.connections[<phone id>]    { wabaId, status: pending|registering|registered|active|failed, consent, reason?, updatedAt }
//                                                     NEVER pruned: it is what explains an active or partially completed connection. No secrets.
//   settings.phoneWhatsapp.lines[]                    the link row the panel reads (added ONLY on activate), source "connect"
//   integrations.whatsappConnect[<phone id>]          { wabaId, tokenEnc, pinEnc }  AES-256-GCM via encryptValue (ENCRYPTION_KEY)
// No code, token or PIN is ever written to a log or returned to the browser.
//
// Coexistence additions (2026-10-19), same connection record:
//   status coex_linking | connected_coexistence | disconnected (with disconnectedFrom, the status to restore on ACCOUNT_RECONNECTED)
//   mode "coexistence", chatwoot { accountId, inboxId, forwardUrl }   the receiver's binding (no secrets)
//   syncs { smb_app_state_sync?, history? : { status requested|rejected|unknown, at, requestId? } }   one-time, never retried
//   historyChunks [ "<phase>:<chunk_order>" ]                          history chunks already imported (idempotency, capped)
// EVERY place that decides "this workspace holds this number" lists the same statuses (Law 21): claimants() here and claimantsOf() in
// ../service/stores.ts. Keep them identical.
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { trackEvent } from "@/lib/analytics/track";
import { encryptValue } from "@/lib/encryption";
import { makeChatwootClient } from "./chatwoot-client";
import { chatwootInboxWebhookUrl, loadCoexConfig } from "./coexistence-config";
import { loadConnectConfig, type ConnectConfig } from "./config";
import { MAX_LIVE_ATTEMPTS, type CoexBinding, type ConnectStore, type ConnectionStatus, type FinalizeDeps, type SyncOutcome, type SyncType } from "./finalize";
import { GraphError, makeGraphClient } from "./meta-graph";
import { HOLDING_STATUSES } from "./holding-statuses";

const holding = sql.raw(HOLDING_STATUSES.map((s) => `'${s}'`).join(","));

const P = (hash: string) => sql`ARRAY['phoneWhatsapp','pending',${hash}]::text[]`;

type Rows = Array<Record<string, unknown>>;
function rowsOf(res: unknown): Rows {
  if (Array.isArray(res)) return res as Rows;
  return ((res as { rows?: Rows } | null)?.rows ?? []) as Rows;
}
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export function makeDbConnectStore(): ConnectStore {

  return {
    async putAttempt(a) {
      const payload = JSON.stringify({ userId: a.userId, expiresAt: a.expiresAt.toISOString(), consent: a.consent });
      const keep = MAX_LIVE_ATTEMPTS - 1;
      await db.execute(sql`
        update organizations set settings = jsonb_set(
          jsonb_set(coalesce(settings,'{}'::jsonb), '{phoneWhatsapp}', coalesce(settings->'phoneWhatsapp','{}'::jsonb), true),
          '{phoneWhatsapp,pending}',
          coalesce((
            select jsonb_object_agg(k, v) from (
              select k, v from jsonb_each(case when jsonb_typeof(settings #> '{phoneWhatsapp,pending}') = 'object' then settings #> '{phoneWhatsapp,pending}' else '{}'::jsonb end) as e(k, v)
              where jsonb_typeof(v) = 'object' and (v->>'expiresAt')::timestamptz > ${a.now.toISOString()}::timestamptz
              order by (v->>'expiresAt')::timestamptz desc limit ${keep}
            ) kept
          ), '{}'::jsonb) || jsonb_build_object(${a.nonceHash}::text, ${payload}::jsonb), true)
        where id = ${a.orgId}::uuid`);
    },
    async consumeAttempt(a) {
      // Atomic and single-use: changed only when org, user and expiry all match; removed in the same statement; returns the consent record.
      const res = await db.execute(sql`
        update organizations o set settings = o.settings #- ${P(a.nonceHash)}
        from (select id, settings #> ${P(a.nonceHash)} as att from organizations where id = ${a.orgId}::uuid) old
        where o.id = old.id
          and old.att is not null
          and old.att ->> 'userId' = ${a.userId}
          and (old.att ->> 'expiresAt')::timestamptz > ${a.now.toISOString()}::timestamptz
        returning old.att as att`);
      const r = rowsOf(res);
      if (r.length !== 1) return null;
      const att = json(r[0].att) as { consent?: { termsVersion: string; at: string; userId: string } } | null;
      return att?.consent ?? null;
    },
    async claimants(phoneNumberId) {
      // A number is held by a workspace when it is a linked line OR an unfinished (non-failed) connection: otherwise two workspaces could race.
      const res = await db.execute(sql`
        select id from organizations
        where settings -> 'phoneWhatsapp' -> 'lines' @> ${JSON.stringify([{ phoneNumberId }])}::jsonb
           or settings #>> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'status'] in (${holding})
        limit 5`);
      return rowsOf(res).map((r) => String(r.id));
    },
    async getConnection(a) {
      const res = await db.execute(sql`
        select settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'status'] as status,
               settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'wabaId'] as waba,
               (integrations #>> ARRAY['whatsappConnect',${a.phoneNumberId},'pinEnc']) is not null as has_pin
        from organizations where id = ${a.orgId}::uuid`);
      const r = rowsOf(res)[0];
      if (!r || !r.status) return null;
      return { status: String(r.status) as ConnectionStatus, wabaId: String(r.waba ?? ""), hasPin: r.has_pin === true };
    },
    async savePending(a) {
      const secret = JSON.stringify({ wabaId: a.wabaId, tokenEnc: a.tokenEnc, ...(a.pinEnc ? { pinEnc: a.pinEnc } : {}) });
      const conn = JSON.stringify({ wabaId: a.wabaId, consent: a.consent, attemptId: a.attemptId, updatedAt: new Date().toISOString() });
      const key = a.phoneNumberId;
      await db.execute(sql`
        update organizations set
          integrations = jsonb_set(coalesce(integrations,'{}'::jsonb), '{whatsappConnect}',
            coalesce(integrations->'whatsappConnect','{}'::jsonb) || jsonb_build_object(${key}::text,
              coalesce(integrations #> ARRAY['whatsappConnect',${key}], '{}'::jsonb) || ${secret}::jsonb), true),
          settings = jsonb_set(
            jsonb_set(coalesce(settings,'{}'::jsonb), '{phoneWhatsapp}', coalesce(settings->'phoneWhatsapp','{}'::jsonb), true),
            '{phoneWhatsapp,connections}',
            coalesce(settings #> '{phoneWhatsapp,connections}','{}'::jsonb) || jsonb_build_object(${key}::text,
              coalesce(settings #> ARRAY['phoneWhatsapp','connections',${key}], '{}'::jsonb) || ${conn}::jsonb
              || jsonb_build_object('status', case when settings #>> ARRAY['phoneWhatsapp','connections',${key},'status'] in ('registered','active')
                                                   then settings #>> ARRAY['phoneWhatsapp','connections',${key},'status'] else 'pending' end)), true)
        where id = ${a.orgId}::uuid`);
    },
    async claimRegistering(a) {
      const conn = JSON.stringify({ status: "registering", updatedAt: new Date().toISOString() });
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,connections}',
          settings #> '{phoneWhatsapp,connections}' || jsonb_build_object(${a.phoneNumberId}::text,
            (settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}]) || ${conn}::jsonb), true)
        where id = ${a.orgId}::uuid
          and settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'status'] = 'pending'
          and settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'attemptId'] = ${a.attemptId}
        returning id`);
      return rowsOf(res).length === 1;
    },
    async setStatus(a) {
      const conn = JSON.stringify({ status: a.status, ...(a.reason ? { reason: a.reason } : {}), updatedAt: new Date().toISOString() });
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,connections}',
          coalesce(settings #> '{phoneWhatsapp,connections}','{}'::jsonb) || jsonb_build_object(${a.phoneNumberId}::text,
            coalesce(settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}], '{}'::jsonb) || ${conn}::jsonb), true)
        where id = ${a.orgId}::uuid and settings #> '{phoneWhatsapp,connections}' is not null
        returning id`);
      if (rowsOf(res).length !== 1) throw new Error("setStatus: no row updated");
    },
    async activate(a) {
      const line = JSON.stringify({ wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, ...(a.label ? { label: a.label.slice(0, 80) } : {}), source: "connect", connectedAt: a.connectedAt });
      const conn = JSON.stringify({ status: "active", connectedAt: a.connectedAt, updatedAt: a.connectedAt });
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(
          jsonb_set(settings, '{phoneWhatsapp,lines}',
            (case when jsonb_typeof(settings #> '{phoneWhatsapp,lines}') = 'array' then settings #> '{phoneWhatsapp,lines}' else '[]'::jsonb end)
            || (case when (settings #> '{phoneWhatsapp,lines}') @> ${JSON.stringify([{ phoneNumberId: a.phoneNumberId }])}::jsonb then '[]'::jsonb else ${`[${line}]`}::jsonb end), true),
          '{phoneWhatsapp,connections}',
          coalesce(settings #> '{phoneWhatsapp,connections}','{}'::jsonb) || jsonb_build_object(${a.phoneNumberId}::text,
            coalesce(settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}], '{}'::jsonb) || ${conn}::jsonb), true)
        where id = ${a.orgId}::uuid and settings #> '{phoneWhatsapp}' is not null
        returning id`);
      if (rowsOf(res).length !== 1) throw new Error("activate: no row updated");
    },
    async activateCoexistence(a) {
      const line = JSON.stringify({ wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, ...(a.label ? { label: a.label.slice(0, 80) } : {}), source: "connect", mode: "coexistence", connectedAt: a.connectedAt });
      const conn = JSON.stringify({
        status: "connected_coexistence",
        mode: "coexistence",
        chatwoot: { accountId: a.binding.chatwootAccountId, inboxId: a.binding.inboxId, forwardUrl: a.binding.forwardUrl },
        connectedAt: a.connectedAt,
        updatedAt: a.connectedAt,
      });
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(
          jsonb_set(settings, '{phoneWhatsapp,lines}',
            (case when jsonb_typeof(settings #> '{phoneWhatsapp,lines}') = 'array' then settings #> '{phoneWhatsapp,lines}' else '[]'::jsonb end)
            || (case when (settings #> '{phoneWhatsapp,lines}') @> ${JSON.stringify([{ phoneNumberId: a.phoneNumberId }])}::jsonb then '[]'::jsonb else ${`[${line}]`}::jsonb end), true),
          '{phoneWhatsapp,connections}',
          coalesce(settings #> '{phoneWhatsapp,connections}','{}'::jsonb) || jsonb_build_object(${a.phoneNumberId}::text,
            coalesce(settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}], '{}'::jsonb) || ${conn}::jsonb), true)
        where id = ${a.orgId}::uuid and settings #> '{phoneWhatsapp}' is not null
          and settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'status'] = 'coex_linking'
        returning id`);
      if (rowsOf(res).length !== 1) throw new Error("activateCoexistence: no row updated");
    },
    async getSyncs(a) {
      const res = await db.execute(sql`select settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'syncs'] as s from organizations where id = ${a.orgId}::uuid`);
      const s = json(rowsOf(res)[0]?.s) as Partial<Record<SyncType, SyncOutcome>> | null;
      return s && typeof s === "object" ? s : {};
    },
    async recordSync(a) {
      // Write-once per sync type: an existing outcome is never overwritten (the request is one-time at Meta).
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(settings, ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'syncs']::text[],
          coalesce(settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'syncs'], '{}'::jsonb) || jsonb_build_object(${a.syncType}::text, ${JSON.stringify(a.outcome)}::jsonb), true)
        where id = ${a.orgId}::uuid
          and settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}] is not null
          and settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'syncs',${a.syncType}] is null
        returning id`);
      if (rowsOf(res).length !== 1) throw new Error("recordSync: no row updated");
    },
  };
}

/** Receiver binding lookup: every workspace whose coexistence connection holds this phone id (more than one = contested, refused). */
export async function findCoexBindings(phoneNumberId: string): Promise<Array<{ orgId: string; status: string; wabaId: string; binding: CoexBinding | null }>> {
  const res = await db.execute(sql`
    select id, settings #> ARRAY['phoneWhatsapp','connections',${phoneNumberId}] as c from organizations
    where settings #>> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'mode'] = 'coexistence'
    limit 5`);
  return rowsOf(res).map((r) => {
    const c = (json(r.c) ?? {}) as { status?: string; wabaId?: string; chatwoot?: { accountId?: unknown; inboxId?: unknown; forwardUrl?: unknown } };
    const cw = c.chatwoot;
    const binding =
      cw && typeof cw.forwardUrl === "string" && typeof cw.inboxId === "number" && (typeof cw.accountId === "string" || typeof cw.accountId === "number")
        ? { chatwootAccountId: String(cw.accountId), inboxId: cw.inboxId, forwardUrl: cw.forwardUrl }
        : null;
    return { orgId: String(r.id), status: String(c.status ?? ""), wabaId: String(c.wabaId ?? ""), binding };
  });
}

/** History-chunk idempotency: true when this chunk key was not imported before (and records it). Capped at the most recent 500 keys. */
export async function markHistoryChunk(orgId: string, phoneNumberId: string, chunkKey: string): Promise<boolean> {
  const res = await db.execute(sql`
    update organizations set settings = jsonb_set(settings, ARRAY['phoneWhatsapp','connections',${phoneNumberId},'historyChunks']::text[],
      (select coalesce(jsonb_agg(k), '[]'::jsonb) from (
         select k from jsonb_array_elements(coalesce(settings #> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'historyChunks'], '[]'::jsonb)) as e(k)
         order by 1 desc limit 499) kept) || jsonb_build_array(${chunkKey}::text), true)
    where id = ${orgId}::uuid
      and settings #> ARRAY['phoneWhatsapp','connections',${phoneNumberId}] is not null
      and not (coalesce(settings #> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'historyChunks'], '[]'::jsonb) @> jsonb_build_array(${chunkKey}::text))
    returning id`);
  return rowsOf(res).length === 1;
}

export async function historyChunkSeen(orgId: string, phoneNumberId: string, chunkKey: string): Promise<boolean> {
  const res = await db.execute(sql`
    select coalesce(settings #> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'historyChunks'], '[]'::jsonb) @> jsonb_build_array(${chunkKey}::text) as seen
    from organizations where id = ${orgId}::uuid`);
  return rowsOf(res)[0]?.seen === true;
}

/** Lifecycle lookup: every connection (any workspace) on this WABA. */
export async function findConnectionsByWaba(wabaId: string): Promise<Array<{ orgId: string; phoneNumberId: string; status: string; disconnectedFrom: string | null }>> {
  const res = await db.execute(sql`
    select o.id, e.k, e.v ->> 'status' as status, e.v ->> 'disconnectedFrom' as dfrom
    from organizations o, jsonb_each(case when jsonb_typeof(o.settings #> '{phoneWhatsapp,connections}') = 'object' then o.settings #> '{phoneWhatsapp,connections}' else '{}'::jsonb end) as e(k, v)
    where e.v ->> 'wabaId' = ${wabaId}
    limit 20`);
  return rowsOf(res).map((r) => ({ orgId: String(r.id), phoneNumberId: String(r.k), status: String(r.status ?? ""), disconnectedFrom: r.dfrom ? String(r.dfrom) : null }));
}

/** Compare-and-set lifecycle transition (only from the expected status). */
export async function setLifecycleStatus(a: { orgId: string; phoneNumberId: string; from: string; to: ConnectionStatus; disconnectedFrom: string | null; reason: string | null; at: string }): Promise<boolean> {
  const conn = JSON.stringify({ status: a.to, disconnectedFrom: a.disconnectedFrom, lifecycleReason: a.reason, updatedAt: a.at });
  const res = await db.execute(sql`
    update organizations set settings = jsonb_set(settings, '{phoneWhatsapp,connections}',
      settings #> '{phoneWhatsapp,connections}' || jsonb_build_object(${a.phoneNumberId}::text,
        (settings #> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId}]) || ${conn}::jsonb), true)
    where id = ${a.orgId}::uuid and settings #>> ARRAY['phoneWhatsapp','connections',${a.phoneNumberId},'status'] = ${a.from}
    returning id`);
  return rowsOf(res).length === 1;
}

/** Audit via the existing product-event log (seldonframe_events). Fire-and-forget by that module's design: never blocks or throws. */
export function auditConnect(orgId: string, step: string, props: Record<string, unknown>): void {
  trackEvent("phone_whatsapp_connect", { step, ...props }, { orgId });
}

/** Connection states for the page (no secrets): used to show a partially completed connection honestly. */
export async function listConnectionStates(
  orgId: string,
): Promise<Array<{ phoneNumberId: string; status: ConnectionStatus; reason: string | null; syncs: Partial<Record<SyncType, SyncOutcome["status"]>> }>> {
  const res = await db.execute(sql`select settings #> '{phoneWhatsapp,connections}' as c from organizations where id = ${orgId}::uuid`);
  const c = json(rowsOf(res)[0]?.c) as Record<string, { status?: string; reason?: string; lifecycleReason?: string; syncs?: Partial<Record<SyncType, SyncOutcome>> }> | null;
  if (!c || typeof c !== "object") return [];
  return Object.entries(c).map(([phoneNumberId, v]) => {
    const syncs: Partial<Record<SyncType, SyncOutcome["status"]>> = {};
    for (const t of ["smb_app_state_sync", "history"] as const) { const s = v?.syncs?.[t]?.status; if (s) syncs[t] = s; }
    return { phoneNumberId, status: (v?.status ?? "pending") as ConnectionStatus, reason: v?.reason ?? v?.lifecycleReason ?? null, syncs };
  });
}

export function getConnectConfig(orgId: string | null | undefined): ConnectConfig {
  return loadConnectConfig(orgId, process.env);
}

export function makeFinalizeDeps(cfg: Extract<ConnectConfig, { ok: true }>, orgId?: string): FinalizeDeps {
  const g = makeGraphClient({ base: cfg.graphBase, appId: cfg.appId, appSecret: cfg.appSecret });
  const coexCfg = orgId ? loadCoexConfig(orgId, process.env, cfg.testMode) : null;
  return {
    store: makeDbConnectStore(),
    graph: g.client,
    exchangeCode: g.exchangeCode,
    register: g.register,
    subscribeApp: g.subscribeApp,
    // Meta explicitly refused (HTTP 4xx): nothing was registered. Timeouts, 5xx and crashes are NOT definite.
    isDefiniteFailure: (e) => e instanceof GraphError && e.status >= 400 && e.status < 500,
    encrypt: encryptValue,
    ourAppId: cfg.appId,
    epicWabaIds: cfg.epicWabaIds,
    protectedPhoneIds: cfg.protectedPhoneIds,
    now: () => new Date(),
    audit: auditConnect,
    ...(coexCfg
      ? {
          coex: {
            async ensureInbox(a) {
              const digits = (a.displayNumber ?? "").replace(/\D/g, "");
              if (!digits) throw new GraphError(502, "display number");
              const phoneE164 = `+${digits}`;
              const cw = makeChatwootClient({ base: coexCfg.chatwootApiBase, accountId: coexCfg.chatwootAccountId, apiToken: coexCfg.chatwootApiToken });
              const r = await cw.ensureWhatsappInbox({ name: `WhatsApp ${a.label ?? phoneE164}`, phoneE164, phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, businessToken: a.token });
              return { chatwootAccountId: coexCfg.chatwootAccountId, inboxId: r.inboxId, forwardUrl: chatwootInboxWebhookUrl(coexCfg.chatwootWebhookBase, phoneE164) };
            },
            setOverride: (token, phone) => g.setPhoneOverride(token, phone, coexCfg.receiverUrl, coexCfg.verifyToken),
            requestSync: (token, phone, t) => g.requestSmbSync(token, phone, t),
          },
        }
      : {}),
  };
}
