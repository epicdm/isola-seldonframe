// Coexistence webhook receiver: the PURE core of /api/phone-whatsapp/webhook/meta. Meta delivers a coexistence number's override-eligible
// fields here (phone-level override set at connect). Chatwoot stays the ONE message processor (Law 1):
//   messages, smb_message_echoes, calls and any field we do not digest   -> forwarded to the bound Chatwoot inbox webhook BYTE-IDENTICAL with
//                                                                            Meta's X-Hub-Signature-256 header preserved; failure = 5xx so Meta
//                                                                            retries (never silently dropped)
//   history, smb_app_state_sync                                          -> digested here into the same inbox via the Chatwoot API (Chatwoot
//                                                                            has no handler for them), idempotently
// Ported from the BFF's app/lib/webhook/coex.ts (d736dbf3a + #294): the same message-text extraction, the same business-vs-customer
// direction rule (message.from equals the business display number), the same per-chunk cap, and contacts upserted by phone. Differences, on
// purpose: the workspace and inbox come from OUR binding (organizations.settings), not the BFF tenant_registry; history lands as private notes
// (Chatwoot refuses API-created incoming messages outside API inboxes); and each history chunk is imported once (phase:chunk_order key).
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChatwootPort } from "./chatwoot-client";

export const DIGEST_FIELDS = new Set(["history", "smb_app_state_sync"]);
export const MAX_HISTORY_MESSAGES_PER_CHUNK = 5000;

/** Meta's X-Hub-Signature-256: "sha256=" + HMAC-SHA256(app secret, raw body). Constant-time compare; any malformed input is false. */
export function verifyMetaSignature(raw: string, header: string | null, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const want = "sha256=" + createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Plan =
  | { ok: false; status: number; code: "bad_json" | "no_phone" | "mixed_phones" }
  | { ok: true; phoneNumberId: string; forward: boolean; digest: Array<{ field: string; value: any }>; fields: string[] };

/** Decides what to do with one Meta POST. A payload must concern exactly one phone number id (a phone override is per number). */
export function planDelivery(raw: string): Plan {
  let body: any;
  try { body = JSON.parse(raw); } catch { return { ok: false, status: 400, code: "bad_json" }; }
  const changes: Array<{ field: string; value: any }> = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) changes.push({ field: String(ch?.field ?? ""), value: ch?.value });
  }
  const phones = new Set(changes.map((c) => c.value?.metadata?.phone_number_id).filter((p): p is string => typeof p === "string" && /^\d{5,20}$/.test(p)));
  if (phones.size === 0) return { ok: false, status: 404, code: "no_phone" };
  if (phones.size > 1) return { ok: false, status: 400, code: "mixed_phones" };
  const digest = changes.filter((c) => DIGEST_FIELDS.has(c.field));
  const forward = changes.some((c) => !DIGEST_FIELDS.has(c.field));
  return { ok: true, phoneNumberId: [...phones][0], forward, digest, fields: changes.map((c) => c.field) };
}

const digitsOf = (p: unknown) => (typeof p === "string" ? p.replace(/\D/g, "") : "");

/** Same mapping as the BFF's extractMessageText. */
export function extractMessageText(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  switch (msg.type) {
    case "text": return msg.text?.body ?? "";
    case "image": return msg.image?.caption ? `[image] ${msg.image.caption}` : "[image]";
    case "video": return msg.video?.caption ? `[video] ${msg.video.caption}` : "[video]";
    case "audio": return "[audio]";
    case "document": return msg.document?.filename ? `[document] ${msg.document.filename}` : "[document]";
    case "sticker": return "[sticker]";
    case "location": return "[location]";
    case "contacts": return "[contact card]";
    case "reaction": return msg.reaction?.emoji ? `[reaction ${msg.reaction.emoji}]` : "[reaction]";
    default: return msg.type ? `[${msg.type}]` : "";
  }
}

export type DigestCtx = {
  chatwoot: ChatwootPort;
  inboxId: number;
  /** True when this chunk key was imported before. */
  seen(chunkKey: string): Promise<boolean>;
  /** Records the chunk key after a successful import. */
  mark(chunkKey: string): Promise<void>;
  log(line: string): void;
};

export type DigestCounts = { chunks: number; skippedChunks: number; threads: number; notes: number; contacts: number; capped: boolean };

const stamp = (ts: unknown) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 && n < 1e11 ? new Date(n * 1000).toISOString().replace(".000Z", "Z") : "time unknown";
};

/** history: value.history[] chunks of { metadata: { phase, chunk_order, progress }, threads: [{ id: <customer wa_id>, messages: [...] }] }. Throws on a Chatwoot failure (the route answers 5xx so Meta redelivers; the chunk is not marked). */
export async function digestHistory(value: any, ctx: DigestCtx, counts: DigestCounts): Promise<void> {
  const businessPhone = digitsOf(value?.metadata?.display_phone_number);
  for (const chunk of Array.isArray(value?.history) ? value.history : []) {
    const meta = chunk?.metadata ?? {};
    if (Array.isArray(chunk?.errors) && chunk.errors.length) ctx.log(`[coex-recv] history chunk carries ${chunk.errors.length} error(s) (e.g. the customer declined sharing)`);
    const key = `${String(meta.phase ?? "x")}:${String(meta.chunk_order ?? "x")}`;
    if (await ctx.seen(key)) { counts.skippedChunks++; continue; }
    let inChunk = 0;
    for (const thread of Array.isArray(chunk?.threads) ? chunk.threads : []) {
      const customer = digitsOf(thread?.id);
      if (!customer) continue;
      const messages = (Array.isArray(thread?.messages) ? thread.messages : []).filter((m: any) => extractMessageText(m));
      if (messages.length === 0) continue;
      counts.threads++;
      const { contactId } = await ctx.chatwoot.ensureContact({ inboxId: ctx.inboxId, phoneDigits: customer });
      const conversationId = await ctx.chatwoot.ensureConversation({ inboxId: ctx.inboxId, contactId, phoneDigits: customer });
      for (const m of messages) {
        if (inChunk >= MAX_HISTORY_MESSAGES_PER_CHUNK) { counts.capped = true; break; }
        const fromBusiness = businessPhone !== "" && digitsOf(m?.from) === businessPhone;
        const who = fromBusiness ? "Business (sent from the WhatsApp Business app)" : "Customer";
        await ctx.chatwoot.createNote({
          conversationId,
          content: `[WhatsApp Business app history - ${who} - ${stamp(m?.timestamp)}]\n${extractMessageText(m)}`,
          sourceId: typeof m?.id === "string" && m.id ? `history:${m.id}` : `history:${key}:${customer}:${inChunk}`,
        });
        inChunk++;
        counts.notes++;
      }
      if (counts.capped) break;
    }
    if (counts.capped) ctx.log(`[coex-recv] history chunk ${key} cap ${MAX_HISTORY_MESSAGES_PER_CHUNK} hit: the rest of this chunk was NOT imported`);
    await ctx.mark(key);
    counts.chunks++;
    ctx.log(`[coex-recv] history chunk ${key} phase=${meta.phase} progress=${meta.progress} notes=${inChunk}`);
  }
}

/** smb_app_state_sync: value.state_sync[] of { type: "contact", contact: { full_name, first_name, phone_number }, action }. Upsert by phone (idempotent); "remove" is logged, never deletes. */
export async function digestStateSync(value: any, ctx: DigestCtx, counts: DigestCounts): Promise<void> {
  let removed = 0;
  for (const item of Array.isArray(value?.state_sync) ? value.state_sync : []) {
    if (item?.type !== "contact") continue;
    if (item?.action === "remove") { removed++; continue; }
    const phone = digitsOf(item?.contact?.phone_number);
    if (!phone) continue;
    const name = (item.contact.full_name || item.contact.first_name || undefined) as string | undefined;
    await ctx.chatwoot.ensureContact({ inboxId: ctx.inboxId, phoneDigits: phone, name });
    counts.contacts++;
  }
  if (removed) ctx.log(`[coex-recv] state_sync: ${removed} contact removal(s) not applied (Chatwoot contacts are never deleted by sync)`);
}

export const emptyCounts = (): DigestCounts => ({ chunks: 0, skippedChunks: 0, threads: 0, notes: 0, contacts: 0, capped: false });

// ─── The request handler, over injected ports (the route wires production; tests drive the same function) ──────────────────────────────

export type ReceiverBinding = { orgId: string; status: string; binding: { chatwootAccountId: string; inboxId: number; forwardUrl: string } | null };

export type ReceiverDeps = {
  appSecret: string;
  /** Every coexistence connection holding this phone id (any workspace). */
  lookup(phoneNumberId: string): Promise<ReceiverBinding[]>;
  /** POSTs the raw body to the inbox webhook with the given headers; resolves the HTTP status, rejects on a network error. */
  forward(url: string, raw: string, headers: Record<string, string>): Promise<number>;
  chatwootFor(binding: NonNullable<ReceiverBinding["binding"]>): ChatwootPort;
  seen(orgId: string, phoneNumberId: string, chunkKey: string): Promise<boolean>;
  mark(orgId: string, phoneNumberId: string, chunkKey: string): Promise<void>;
  log(line: string): void;
};

export type ReceiverResult = { status: number; body: Record<string, unknown> };

/** Statuses whose number is served. 'disconnected' is served too: Meta may still deliver the last events, and Chatwoot keeps the record. */
const SERVED = new Set(["connected_coexistence", "disconnected"]);

export async function handleReceiverPost(raw: string, signature: string | null, deps: ReceiverDeps): Promise<ReceiverResult> {
  if (!verifyMetaSignature(raw, signature, deps.appSecret)) return { status: 401, body: { ok: false, code: "bad_signature" } };
  const plan = planDelivery(raw);
  if (!plan.ok) {
    deps.log(`[coex-recv] refused ${plan.code}`);
    return { status: plan.status, body: { ok: false, code: plan.code } };
  }
  const holders = (await deps.lookup(plan.phoneNumberId)).filter((h) => SERVED.has(h.status) && h.binding);
  if (holders.length !== 1) {
    deps.log(`[coex-recv] ${holders.length === 0 ? "unknown" : "contested"} phone_number_id=${plan.phoneNumberId} fields=${plan.fields.join(",")}`);
    return { status: 404, body: { ok: false, code: holders.length === 0 ? "unknown_number" : "contested_number" } };
  }
  const h = holders[0];
  const b = h.binding!;

  if (plan.forward) {
    let st: number | "network_error";
    try {
      st = await deps.forward(b.forwardUrl, raw, { "content-type": "application/json", "x-hub-signature-256": signature! });
    } catch {
      st = "network_error";
    }
    if (st === "network_error" || st < 200 || st >= 300) {
      deps.log(`[coex-recv] forward failed status=${st} phone_number_id=${plan.phoneNumberId} fields=${plan.fields.join(",")}`);
      return { status: 502, body: { ok: false, code: "forward_failed" } };
    }
  }

  if (plan.digest.length) {
    const counts = emptyCounts();
    const ctx: DigestCtx = {
      chatwoot: deps.chatwootFor(b),
      inboxId: b.inboxId,
      seen: (k) => deps.seen(h.orgId, plan.phoneNumberId, k),
      mark: (k) => deps.mark(h.orgId, plan.phoneNumberId, k),
      log: deps.log,
    };
    try {
      for (const d of plan.digest) {
        if (d.field === "history") await digestHistory(d.value, ctx, counts);
        else if (d.field === "smb_app_state_sync") await digestStateSync(d.value, ctx, counts);
      }
    } catch (e) {
      // Not marked: Meta redelivers and the unfinished chunk is imported again (a crash mid-chunk can duplicate notes; documented limit).
      deps.log(`[coex-recv] digest failed (${e instanceof Error ? e.name : "error"}) phone_number_id=${plan.phoneNumberId} counts=${JSON.stringify(counts)}`);
      return { status: 500, body: { ok: false, code: "digest_failed" } };
    }
    deps.log(`[coex-recv] digested phone_number_id=${plan.phoneNumberId} counts=${JSON.stringify(counts)}`);
  }
  return { status: 200, body: { ok: true } };
}

/** Meta's GET verification: echo hub.challenge only for mode=subscribe and our own verify token. */
export function handleReceiverVerify(params: URLSearchParams, verifyToken: string): { status: number; text: string } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !verifyToken || token.length !== verifyToken.length) return { status: 403, text: "forbidden" };
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken))) return { status: 403, text: "forbidden" };
  return { status: 200, text: challenge };
}
