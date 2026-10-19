// Server-only storage for the calling-service increment. Everything lives on the workspace's OWN organizations row under settings.phoneWhatsapp, written only by
// statements scoped to that row's id (the id always comes from the server session or from the number's verified binding, never from a request body):
//   service[<phone id>]       attach ledger: { idempotencyKey, destinationId, steps, status, leaseUntil }
//   destinations[]            STAFF-maintained catalog of selectable destinations for this workspace (customers cannot write it)
//   agents[]                  stand-in for the existing agent registry (preview only; production reads the real registry through the AgentDirectory port)
//   callEvents[<phone id>]    Meta calling events captured for this number (latest 20)
//   acceptance[<phone id>]    owner/admin acceptance statements with the evidence they rest on (latest 50); never deleted by a route change, only superseded
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { HOLDING_STATUSES } from "../connect/holding-statuses";
import type { AgentDirectory, DestinationOption } from "./destinations";
import type { AttachLedger, AttachLedgerRecord } from "./attach";
import type { Attestation, MetaCallEvent } from "./acceptance";

type Rows = Array<Record<string, unknown>>;
const rowsOf = (res: unknown): Rows => (Array.isArray(res) ? (res as Rows) : (((res as { rows?: Rows } | null)?.rows ?? []) as Rows));
const parse = <T,>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

const PW = sql`'{phoneWhatsapp}'`;
const ensurePw = sql`jsonb_set(coalesce(settings,'{}'::jsonb), '{phoneWhatsapp}', coalesce(settings->'phoneWhatsapp','{}'::jsonb), true)`;

export function makeAttachLedger(): AttachLedger {
  const path = (phone: string) => sql`ARRAY['phoneWhatsapp','service',${phone}]::text[]`;
  const base = (phone: string) => sql`settings #> ${path(phone)}`;
  return {
    async get(workspaceId, phone) {
      const r = rowsOf(await db.execute(sql`select ${base(phone)} as rec from organizations where id = ${workspaceId}::uuid`))[0];
      return parse<AttachLedgerRecord>(r?.rec);
    },
    async begin(a) {
      const next = JSON.stringify({ idempotencyKey: a.idempotencyKey, destinationId: a.destinationId, status: "in_progress", leaseUntil: new Date(a.now.getTime() + a.leaseMs).toISOString() });
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(
          jsonb_set(${ensurePw}, '{phoneWhatsapp,service}', coalesce(settings #> '{phoneWhatsapp,service}','{}'::jsonb), true),
          '{phoneWhatsapp,service}',
          coalesce(settings #> '{phoneWhatsapp,service}','{}'::jsonb) || jsonb_build_object(${a.phoneNumberId}::text,
            jsonb_build_object('steps', coalesce(${base(a.phoneNumberId)} -> 'steps', '{}'::jsonb)) || ${next}::jsonb), true)
        where id = ${a.workspaceId}::uuid
          and not coalesce( (${base(a.phoneNumberId)} ->> 'status') = 'in_progress'
                            and ((${base(a.phoneNumberId)} ->> 'leaseUntil')::timestamptz > ${a.now.toISOString()}::timestamptz), false)
        returning id`);
      return rowsOf(res).length === 1;
    },
    async recordStep(a) {
      const res = await db.execute(sql`
        update organizations set settings = jsonb_set(settings, ARRAY['phoneWhatsapp','service',${a.phoneNumberId},'steps',${a.step}]::text[], ${JSON.stringify(a.rec)}::jsonb, true)
        where id = ${a.workspaceId}::uuid and settings #> ${path(a.phoneNumberId)} is not null returning id`);
      if (rowsOf(res).length !== 1) throw new Error("recordStep: no ledger row");
    },
    async finish(a) {
      await db.execute(sql`
        update organizations set settings = jsonb_set(jsonb_set(settings, ARRAY['phoneWhatsapp','service',${a.phoneNumberId},'status']::text[], to_jsonb(${a.status}::text), true),
          ARRAY['phoneWhatsapp','service',${a.phoneNumberId},'leaseUntil']::text[], 'null'::jsonb, true)
        where id = ${a.workspaceId}::uuid and settings #> ${path(a.phoneNumberId)} is not null`);
    },
  };
}

async function readPath<T>(workspaceId: string, p: string[]): Promise<T | null> {
  const arr = sql`ARRAY[${sql.join(p.map((x) => sql`${x}`), sql`, `)}]::text[]`; // path elements are bound parameters, never interpolated
  const r = rowsOf(await db.execute(sql`select settings #> ${arr} as v from organizations where id = ${workspaceId}::uuid`))[0];
  return parse<T>(r?.v);
}

export const readDestinationCatalog = async (workspaceId: string) => (await readPath<DestinationOption[]>(workspaceId, ["phoneWhatsapp", "destinations"])) ?? [];

/** Preview stand-in for the existing agent registry (SIMULATED). Production wiring of AgentDirectory to the real registry is a separate gate. */
export function makeAgentDirectory(): AgentDirectory {
  return { async exists(agentRef, workspaceId) { const a = (await readPath<Array<{ ref: string }>>(workspaceId, ["phoneWhatsapp", "agents"])) ?? []; return a.some((x) => x.ref === agentRef); } };
}

export const readCallEvents = async (workspaceId: string, phone: string) => (await readPath<MetaCallEvent[]>(workspaceId, ["phoneWhatsapp", "callEvents", phone])) ?? [];
export const readAcceptance = async (workspaceId: string, phone: string) => (await readPath<Array<Attestation & { evidence: unknown }>>(workspaceId, ["phoneWhatsapp", "acceptance", phone])) ?? [];

async function append(workspaceId: string, key: string, phone: string, item: unknown, cap: number, unlessCallId?: string) {
  // atomic append + cap, scoped to the one workspace row. With unlessCallId the row is updated only if no element carries that call id: the
  // condition is re-checked on the latest row version when two deliveries race, so a call id is stored at most once (Codex review).
  await db.execute(sql`
    update organizations set settings = jsonb_set(
      jsonb_set(${ensurePw}, ARRAY['phoneWhatsapp',${key}]::text[], coalesce(settings #> ARRAY['phoneWhatsapp',${key}], '{}'::jsonb), true),
      ARRAY['phoneWhatsapp',${key},${phone}]::text[],
      (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
         select e, n from jsonb_array_elements(coalesce(settings #> ARRAY['phoneWhatsapp',${key},${phone}], '[]'::jsonb) || ${JSON.stringify([item])}::jsonb) with ordinality as t(e, n)
         order by n desc limit ${cap}) s), true)
    where id = ${workspaceId}::uuid
      and (${unlessCallId ?? null}::text is null
           or not coalesce(settings #> ARRAY['phoneWhatsapp',${key},${phone}], '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('callId', ${unlessCallId ?? null}::text)))`);
}
export const appendCallEvent = (w: string, phone: string, ev: MetaCallEvent) => append(w, "callEvents", phone, ev, 20, ev.callId);
export const appendAcceptance = (w: string, phone: string, a: unknown) => append(w, "acceptance", phone, a, 50);

// Same list as connect/server-wiring.ts claimants() (Law 21), from the one shared constant.
const holding = sql.raw(HOLDING_STATUSES.map((s) => `'${s}'`).join(","));

/** Who holds this number (linked line or unfinished connection): used to derive the workspace for service-to-service events. */
export async function claimantsOf(phone: string): Promise<string[]> {
  return rowsOf(await db.execute(sql`
    select id from organizations
    where settings -> 'phoneWhatsapp' -> 'lines' @> ${JSON.stringify([{ phoneNumberId: phone }])}::jsonb
       or settings #>> ARRAY['phoneWhatsapp','connections',${phone},'status'] in (${holding}) limit 5`)).map((r) => String(r.id));
}

export async function connectionStatusOf(workspaceId: string, phone: string): Promise<"pending" | "registering" | "registered" | "active" | "failed" | null> {
  const r = rowsOf(await db.execute(sql`select settings #>> ARRAY['phoneWhatsapp','connections',${phone},'status'] as s from organizations where id = ${workspaceId}::uuid`))[0];
  return (r?.s as never) ?? null;
}

export async function activeLinesOf(workspaceId: string): Promise<Array<{ phoneNumberId: string; wabaId: string }>> {
  const l = (await readPath<Array<{ phoneNumberId: string; wabaId: string }>>(workspaceId, ["phoneWhatsapp", "lines"])) ?? [];
  return Array.isArray(l) ? l : [];
}
void PW;
