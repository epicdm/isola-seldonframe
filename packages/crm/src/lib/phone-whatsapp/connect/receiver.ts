// Coexistence webhook receiver: the PURE core of /api/phone-whatsapp/webhook/meta. Meta delivers a coexistence number's override-eligible
// fields here (phone-level override set at connect). Chatwoot stays the ONE message processor (Law 1):
//   messages, smb_message_echoes, calls and any field we do not digest   -> forwarded to the bound Chatwoot inbox webhook BYTE-IDENTICAL with
//                                                                            Meta's X-Hub-Signature-256 header preserved; failure = 5xx so Meta
//                                                                            retries (never silently dropped)
//   history, smb_app_state_sync                                          -> digested here into the same inbox via the Chatwoot API (Chatwoot
//                                                                            has no handler for them), idempotently
// Ported from the BFF's app/lib/webhook/coex.ts (d736dbf3a + #294): the same message-text extraction, the same business-vs-customer
// direction rule (message.from equals the business display number), the same per-chunk cap, and contacts upserted by phone. Differences, on
// purpose: the workspace and inbox come from OUR binding (organizations.settings), not the BFF tenant_registry; history lands as private activity entries
// (Chatwoot refuses API-created incoming messages outside API inboxes; activity entries are never dispatched to bots, webhooks or automations); and each history chunk is imported once (phase:chunk_order key).
import { createHmac, timingSafeEqual } from "node:crypto";

import { aiAttached, type ChatwootPort } from "./chatwoot-client";

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
  /** Re-checked before EACH conversation's entries: throws AiAttachedError when an AI is now attached; any other throw = check failed. */
  aiCheck(): Promise<void>;
  log(line: string): void;
};

/** An AI (agent bot or Captain) was attached to the inbox while importing: the remaining entries are not written. */
export class AiAttachedError extends Error {
  constructor(public readonly ai: "agent_bot" | "captain") {
    super(`ai attached: ${ai}`);
    this.name = "AiAttachedError";
  }
}

/** The AI check itself failed while importing (fail closed: the remaining entries are not written). */
export class AiCheckFailedError extends Error {
  constructor(public readonly reason: unknown) {
    super("ai check failed");
    this.name = "AiCheckFailedError";
  }
}

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
      await ctx.aiCheck(); // re-checked before each conversation's entries (the entries themselves are never dispatched to a bot; see client)
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
  /** Sync types whose import was skipped for this connection (sticky: recorded once, never cleared automatically). */
  skipped(orgId: string, phoneNumberId: string): Promise<Set<string>>;
  /** Records, once per sync type, that its import was skipped because an agent bot is attached to the inbox. */
  /** Records, once per sync type, that its import was skipped because an AI (agent bot or Captain) is attached. Throws when not recorded. */
  recordSkip(orgId: string, phoneNumberId: string, syncType: string, status: "skipped_bot_attached"): Promise<void>;
  /** Audit record (no secrets, no message content). Must never throw. */
  audit?(orgId: string, step: string, props: Record<string, unknown>): void;
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

  // ORDER (2026-10-19, Codex): DIGEST FIRST, FORWARD SECOND. Every refusal of the import (AI check failed, skip not recorded, digest failed)
  // answers 5xx BEFORE anything is forwarded, so Meta's redelivery of the SAME delivery forwards it exactly once; history chunks already
  // imported are marked and are not imported again. A forward failure after the digest answers 502: the redelivery skips the marked chunks
  // and forwards again, which re-sends only what Chatwoot did not acknowledge (and Chatwoot's WhatsApp intake ignores a message or echo whose
  // source id it already has: Whatsapp::IncomingMessageBaseService, find_message_by_source_id).
  let digestInfo: Record<string, unknown> = {};
  if (plan.digest.length) {
    const r = await digestGuarded(plan.phoneNumberId, plan.digest, h, b, deps);
    if ("status" in r) return r;
    digestInfo = r.info;
  }

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
  return { status: 200, body: { ok: true, ...digestInfo } };
}

type DigestItem = { field: string; value: unknown };

/**
 * AI GUARD (2026-10-19). An AI attached to the inbox (an agent bot, or a Captain assistant) must never be handed the imported history, so
 * history and contacts are imported ONLY into an inbox with neither attached. Fail closed: a failed or ambiguous check imports nothing and
 * answers 503 (nothing is marked; Meta redelivers the SAME delivery, Law 10). A skip is recorded once per sync type and is sticky; if it
 * cannot be recorded the answer is 503 (never 200), so a later delivery cannot import after the AI is removed. The check is repeated before
 * each conversation's entries; an AI found mid-import stops the remaining writes and records the skip.
 */
async function digestGuarded(
  phoneNumberId: string,
  items: DigestItem[],
  h: ReceiverBinding,
  b: NonNullable<ReceiverBinding["binding"]>,
  deps: ReceiverDeps,
): Promise<ReceiverResult | { info: Record<string, unknown> }> {
  const chatwoot = deps.chatwootFor(b);
  const fields = [...new Set(items.map((d) => d.field))];
  const checkFailed = (e: unknown): ReceiverResult => {
    deps.log(`[coex-recv] AI check failed (${e instanceof Error ? e.name : "error"}) phone_number_id=${phoneNumberId} fields=${fields.join(",")}: nothing more imported`);
    deps.audit?.(h.orgId, "import_bot_check_failed", { phoneNumberId, fields });
    return { status: 503, body: { ok: false, code: "bot_check_failed" } };
  };
  const recordSkips = async (skipped: Set<string>, ai: string): Promise<ReceiverResult | null> => {
    for (const f of fields) {
      if (skipped.has(f)) continue;
      try {
        await deps.recordSkip(h.orgId, phoneNumberId, f, "skipped_bot_attached");
      } catch {
        deps.log(`[coex-recv] skip NOT recorded field=${f} phone_number_id=${phoneNumberId}: answering 503 (Meta redelivers), nothing imported`);
        deps.audit?.(h.orgId, "import_skip_record_failed", { phoneNumberId, field: f });
        return { status: 503, body: { ok: false, code: "skip_record_failed" } };
      }
    }
    deps.audit?.(h.orgId, "import_skipped_bot_attached", { phoneNumberId, fields, chatwootInboxId: b.inboxId, ai });
    deps.log(`[coex-recv] NOT imported: ${ai} attached to inbox ${b.inboxId} phone_number_id=${phoneNumberId} fields=${fields.join(",")}`);
    return null;
  };

  let skipped: Set<string>;
  let ai: "agent_bot" | "captain" | null;
  try {
    skipped = await deps.skipped(h.orgId, phoneNumberId);
    ai = fields.every((f) => skipped.has(f)) ? null : await aiAttached(chatwoot, b.inboxId);
  } catch (e) {
    return checkFailed(e);
  }
  if (ai) {
    const fail = await recordSkips(skipped, ai);
    return fail ?? { info: { imported: false, code: "skipped_bot_attached", ai } };
  }
  const digest = items.filter((d) => !skipped.has(d.field));
  if (!digest.length) {
    deps.log(`[coex-recv] NOT imported: import skipped earlier for this connection phone_number_id=${phoneNumberId} fields=${fields.join(",")}`);
    return { info: { imported: false, code: "import_skipped_earlier" } };
  }
  const counts = emptyCounts();
  const ctx: DigestCtx = {
    chatwoot,
    inboxId: b.inboxId,
    seen: (k) => deps.seen(h.orgId, phoneNumberId, k),
    mark: (k) => deps.mark(h.orgId, phoneNumberId, k),
    async aiCheck() {
      let now: "agent_bot" | "captain" | null;
      try {
        now = await aiAttached(chatwoot, b.inboxId);
      } catch (e) {
        throw new AiCheckFailedError(e);
      }
      if (now) throw new AiAttachedError(now);
    },
    log: deps.log,
  };
  try {
    for (const d of digest) {
      if (d.field === "history") await digestHistory(d.value, ctx, counts);
      else if (d.field === "smb_app_state_sync") await digestStateSync(d.value, ctx, counts);
    }
  } catch (e) {
    if (e instanceof AiAttachedError) {
      const fail = await recordSkips(skipped, e.ai);
      deps.log(`[coex-recv] import STOPPED mid-way: ${e.ai} attached phone_number_id=${phoneNumberId} counts=${JSON.stringify(counts)}`);
      return fail ?? { info: { imported: false, code: "skipped_bot_attached", ai: e.ai, partial: counts.notes > 0 || counts.contacts > 0 } };
    }
    // AI check failed mid-way (503), or a Chatwoot write failed (500): not marked; Meta redelivers and the unfinished chunk is imported again
    // (a crash mid-chunk can duplicate entries; documented limit).
    if (e instanceof AiCheckFailedError) return checkFailed(e.reason);
    deps.log(`[coex-recv] digest failed (${e instanceof Error ? e.name : "error"}) phone_number_id=${phoneNumberId} counts=${JSON.stringify(counts)}`);
    return { status: 500, body: { ok: false, code: "digest_failed" } };
  }
  deps.log(`[coex-recv] digested phone_number_id=${phoneNumberId} counts=${JSON.stringify(counts)}`);
  return { info: { imported: true } };
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
