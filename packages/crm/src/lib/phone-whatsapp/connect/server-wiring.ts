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
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { encryptValue } from "@/lib/encryption";
import { loadConnectConfig, type ConnectConfig } from "./config";
import { MAX_LIVE_ATTEMPTS, type ConnectStore, type ConnectionStatus, type FinalizeDeps } from "./finalize";
import { GraphError, makeGraphClient } from "./meta-graph";

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
           or settings #>> ARRAY['phoneWhatsapp','connections',${phoneNumberId},'status'] in ('pending','registering','registered','active')
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
  };
}

/** Connection states for the page (no secrets): used to show a partially completed connection honestly. */
export async function listConnectionStates(orgId: string): Promise<Array<{ phoneNumberId: string; status: ConnectionStatus; reason: string | null }>> {
  const res = await db.execute(sql`select settings #> '{phoneWhatsapp,connections}' as c from organizations where id = ${orgId}::uuid`);
  const c = json(rowsOf(res)[0]?.c) as Record<string, { status?: string; reason?: string }> | null;
  if (!c || typeof c !== "object") return [];
  return Object.entries(c).map(([phoneNumberId, v]) => ({ phoneNumberId, status: (v?.status ?? "pending") as ConnectionStatus, reason: v?.reason ?? null }));
}

export function getConnectConfig(orgId: string | null | undefined): ConnectConfig {
  return loadConnectConfig(orgId, process.env);
}

export function makeFinalizeDeps(cfg: Extract<ConnectConfig, { ok: true }>): FinalizeDeps {
  const g = makeGraphClient({ base: cfg.graphBase, appId: cfg.appId, appSecret: cfg.appSecret });
  return {
    store: makeDbConnectStore(),
    graph: g.client,
    exchangeCode: g.exchangeCode,
    register: g.register,
    // Meta explicitly refused (HTTP 4xx): nothing was registered. Timeouts, 5xx and crashes are NOT definite.
    isDefiniteFailure: (e) => e instanceof GraphError && e.status >= 400 && e.status < 500,
    encrypt: encryptValue,
    ourAppId: cfg.appId,
    epicWabaIds: cfg.epicWabaIds,
    protectedPhoneIds: cfg.protectedPhoneIds,
    now: () => new Date(),
  };
}
