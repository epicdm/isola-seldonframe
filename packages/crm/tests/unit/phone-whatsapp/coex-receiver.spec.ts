// The coexistence receiver, through its request handler (the same function the route calls). Fictional ids and secrets only.
// Every "nothing happened" has a positive twin in the same harness.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import type { ChatwootPort } from "../../../src/lib/phone-whatsapp/connect/chatwoot-client";
import {
  handleReceiverPost,
  handleReceiverVerify,
  planDelivery,
  verifyMetaSignature,
  type ReceiverBinding,
  type ReceiverDeps,
} from "../../../src/lib/phone-whatsapp/connect/receiver";

const SECRET = ["fixture", "app", "secret", "only"].join("-"); // fictional test value, not a credential
const PHONE = "900000000000002";
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const FWD = "https://cw.test/webhooks/whatsapp/%2B15550100";
const sign = (raw: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const body = (field: string, value: Record<string, unknown>, phone = PHONE) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "900000000000001", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550100", phone_number_id: phone }, ...value } }] }] });
const msgBody = () => body("messages", { contacts: [{ wa_id: "15550001" }], messages: [{ from: "15550001", id: "wamid.in1", timestamp: "1792300000", type: "text", text: { body: "hello" } }] });
const echoBody = () => body("smb_message_echoes", { message_echoes: [{ from: "15550100", to: "15550001", id: "wamid.e1", timestamp: "1792300001", type: "text", text: { body: "from the app" } }] });
const historyBody = (chunk = 1, phase = 0) =>
  body("history", {
    history: [{
      metadata: { phase, chunk_order: chunk, progress: 50 },
      threads: [
        { id: "15550001", messages: [
          { from: "15550001", id: "wamid.h1", timestamp: "1780000000", type: "text", text: { body: "old question" } },
          { from: "15550100", id: "wamid.h2", timestamp: "1780000060", type: "text", text: { body: "old answer" } },
          { from: "15550001", id: "wamid.h3", timestamp: "1780000120" }, // no type: no text, skipped (as in the BFF digester)
        ] },
        { id: "15550002", messages: [{ from: "15550002", id: "wamid.h4", timestamp: "1780000200", type: "image", image: { caption: "pic" } }] },
      ],
    }],
  });
const stateBody = () => body("smb_app_state_sync", { state_sync: [
  { type: "contact", action: "add", contact: { full_name: "Ann Fict", phone_number: "15550003" } },
  { type: "contact", action: "remove", contact: { phone_number: "15550004" } },
  { type: "contact", action: "add", contact: { first_name: "Bo", phone_number: "+1 555 0005" } },
] });

function harness(o: { holders?: ReceiverBinding[]; forwardStatus?: number | "throw"; chatwootFails?: boolean; bot?: "none" | "attached" | "captain" | "fails" | "ambiguous"; skippedPre?: string[]; botAfterChecks?: number; failAfterChecks?: number; recordSkipFails?: boolean } = {}) {
  const captainChecks: number[] = [];
  const skips: Array<{ syncType: string; status: string }> = [];
  const audits: string[] = [];
  const botChecks: number[] = [];
  const skippedSet = new Set<string>(o.skippedPre ?? []);
  const forwards: Array<{ url: string; raw: string; headers: Record<string, string> }> = [];
  const notes: Array<{ conversationId: number; content: string; sourceId: string }> = [];
  const contacts: Array<{ phone: string; name?: string }> = [];
  const marked = new Set<string>();
  const logs: string[] = [];
  const cw: ChatwootPort = {
    async ensureWhatsappInbox() { throw new Error("not used"); },
    async ensureContact(a) { if (o.chatwootFails) throw new Error("cw down"); contacts.push({ phone: a.phoneDigits, name: a.name }); return { contactId: Number(a.phoneDigits.slice(-3)), created: true }; },
    async ensureConversation(a) { return 1000 + a.contactId; },
    async createNote(a) { notes.push(a); },
    async inboxBotAttached(inboxId) {
      botChecks.push(inboxId);
      if (o.bot === "fails" || o.bot === "ambiguous") throw new Error("bot check");
      if (o.failAfterChecks !== undefined && botChecks.length > o.failAfterChecks) throw new Error("bot check");
      return o.bot === "attached" || (o.botAfterChecks !== undefined && botChecks.length > o.botAfterChecks);
    },
    async inboxCaptainAttached(inboxId) { captainChecks.push(inboxId); return o.bot === "captain"; },
  };
  const deps: ReceiverDeps = {
    appSecret: SECRET,
    async lookup(phone) {
      return o.holders ?? (phone === PHONE ? [{ orgId: ORG, status: "connected_coexistence", binding: { chatwootAccountId: "2", inboxId: 77, forwardUrl: FWD } }] : []);
    },
    async forward(url, raw, headers) {
      forwards.push({ url, raw, headers });
      if (o.forwardStatus === "throw") throw new Error("net");
      return o.forwardStatus ?? 200;
    },
    chatwootFor: () => cw,
    async seen(_o, _p, k) { return marked.has(k); },
    async mark(_o, _p, k) { marked.add(k); },
    async skipped() { return new Set(skippedSet); },
    async recordSkip(_o, _p, syncType, status) { if (o.recordSkipFails) throw new Error("db"); skips.push({ syncType, status }); skippedSet.add(syncType); },
    audit: (_o, step) => audits.push(step),
    log: (l) => logs.push(l),
  };
  const post = (raw: string, sig: string | null = sign(raw)) => handleReceiverPost(raw, sig, deps);
  return { post, forwards, notes, contacts, marked, logs, skips, audits, botChecks, captainChecks, opts: o };
}

describe("signature", () => {
  test("a bad, missing or other-secret signature is 401 and nothing is forwarded (twin: the correct one is forwarded)", async () => {
    const h = harness();
    const raw = msgBody();
    for (const sig of [null, "sha256=00", sign(raw, "other-secret"), sign(raw).replace("sha256=", "sha1=")]) assert.equal((await h.post(raw, sig)).status, 401);
    assert.equal(h.forwards.length, 0);
    assert.equal((await h.post(raw)).status, 200);
    assert.equal(h.forwards.length, 1);
    assert.equal(verifyMetaSignature(raw, sign(raw), ""), false); // no secret configured = nothing verifies
  });
});

describe("forwarding to the single processor (Chatwoot)", () => {
  test("messages: forwarded once, BYTE-IDENTICAL, with Meta's signature header preserved, to the bound inbox", async () => {
    const h = harness();
    const raw = msgBody();
    assert.equal((await h.post(raw)).status, 200);
    assert.deepEqual(h.forwards.map((f) => [f.url, f.raw === raw, f.headers["x-hub-signature-256"] === sign(raw)]), [[FWD, true, true]]);
    assert.equal(h.notes.length + h.contacts.length, 0); // nothing digested here for messages
  });
  test("echoes and calls and unknown fields are forwarded too (never dropped)", async () => {
    const h = harness();
    for (const raw of [echoBody(), body("calls", { calls: [{ id: "wacid.1" }] }), body("some_new_field", { x: 1 })]) assert.equal((await h.post(raw)).status, 200);
    assert.equal(h.forwards.length, 3);
  });
  test("forward failure (5xx, 4xx or network) answers 5xx so Meta redelivers (twin: 2xx answers 200)", async () => {
    for (const st of [500, 422, "throw"] as const) {
      const h = harness({ forwardStatus: st });
      assert.equal((await h.post(msgBody())).status, 502, String(st));
    }
    assert.equal((await harness({ forwardStatus: 204 }).post(msgBody())).status, 200);
  });
  test("unknown or contested number: 404, logged, nothing forwarded (twin: the bound number is forwarded)", async () => {
    const h = harness();
    assert.equal((await h.post(body("messages", {}, "900000000000099"))).status, 404);
    assert.ok(h.logs.some((l) => l.includes("unknown phone_number_id=900000000000099")));
    const two = harness({ holders: [
      { orgId: ORG, status: "connected_coexistence", binding: { chatwootAccountId: "2", inboxId: 77, forwardUrl: FWD } },
      { orgId: "bbbbbbbb-0000-4000-8000-000000000002", status: "connected_coexistence", binding: { chatwootAccountId: "3", inboxId: 9, forwardUrl: "https://x.test" } },
    ] });
    assert.equal((await two.post(msgBody())).status, 404);
    const unbound = harness({ holders: [{ orgId: ORG, status: "coex_linking", binding: null }] });
    assert.equal((await unbound.post(msgBody())).status, 404); // not finished connecting: not served
    assert.equal(h.forwards.length + two.forwards.length + unbound.forwards.length, 0);
    assert.equal((await h.post(msgBody())).status, 200);
  });
  test("payload naming two phone ids, or none, is refused", async () => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE } } }, { field: "messages", value: { metadata: { phone_number_id: "900000000000003" } } }] }] });
    assert.deepEqual(planDelivery(raw), { ok: false, status: 400, code: "mixed_phones" });
    assert.deepEqual(planDelivery(JSON.stringify({ entry: [] })), { ok: false, status: 404, code: "no_phone" });
    assert.deepEqual(planDelivery("{not json"), { ok: false, status: 400, code: "bad_json" });
  });
});

describe("digesting history and contacts (Chatwoot has no handler for them)", () => {
  test("history: one private note per message with text, labelled by direction (business = display number), NOT forwarded", async () => {
    const h = harness();
    assert.equal((await h.post(historyBody())).status, 200);
    assert.equal(h.forwards.length, 0);
    assert.equal(h.notes.length, 3); // wamid.h3 has no type, so no text, and is skipped
    assert.match(h.notes[0].content, /Customer/); assert.match(h.notes[0].content, /old question/);
    assert.match(h.notes[1].content, /Business \(sent from the WhatsApp Business app\)/);
    assert.match(h.notes[2].content, /\[image\] pic/);
    assert.deepEqual(h.notes.map((n) => n.sourceId), ["history:wamid.h1", "history:wamid.h2", "history:wamid.h4"]);
    assert.deepEqual([...h.marked], ["0:1"]);
  });
  test("idempotent: the same chunk delivered again imports nothing (twin: a new chunk imports)", async () => {
    const h = harness();
    await h.post(historyBody(1));
    await h.post(historyBody(1));
    assert.equal(h.notes.length, 3);
    await h.post(historyBody(2));
    assert.equal(h.notes.length, 6);
  });
  test("Chatwoot failure while digesting: 500 (Meta redelivers) and the chunk is NOT marked (twin: success marks it)", async () => {
    const h = harness({ chatwootFails: true });
    assert.equal((await h.post(historyBody())).status, 500);
    assert.equal(h.marked.size, 0);
  });
  test("contacts: added/edited contacts upserted by phone; removals never applied (logged)", async () => {
    const h = harness();
    assert.equal((await h.post(stateBody())).status, 200);
    assert.deepEqual(h.contacts, [{ phone: "15550003", name: "Ann Fict" }, { phone: "15550005", name: "Bo" }]);
    assert.ok(h.logs.some((l) => l.includes("1 contact removal(s) not applied")));
    assert.equal(h.forwards.length, 0);
  });
});

test("GET verification: echoes the challenge only for subscribe + our token (twin: wrong token refused)", () => {
  const token = "verify-token-0123456789";
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  assert.deepEqual(handleReceiverVerify(q({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" }), token), { status: 200, text: "42" });
  assert.equal(handleReceiverVerify(q({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token-0123456789", "hub.challenge": "42" }), token).status, 403);
  assert.equal(handleReceiverVerify(q({ "hub.mode": "unsubscribe", "hub.verify_token": token, "hub.challenge": "42" }), token).status, 403);
  assert.equal(handleReceiverVerify(q({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "42" }), "").status, 403);
});

describe("bot guard: history and contacts are imported only into an inbox with NO AI bot attached", () => {
  test("positive control: no bot -> the check runs on the bound inbox and history and contacts are imported", async () => {
    const h = harness({ bot: "none" });
    assert.equal((await h.post(historyBody())).status, 200);
    const fromHistory = h.contacts.length; // history threads create their contacts too
    assert.equal((await h.post(stateBody())).status, 200);
    assert.ok(h.botChecks.length >= 2 && h.botChecks.every((i) => i === 77), String(h.botChecks));
    assert.ok(h.captainChecks.length >= 2 && h.captainChecks.every((i) => i === 77));
    assert.equal(h.notes.length, 3);
    assert.equal(h.contacts.length - fromHistory, 2);
    assert.deepEqual(h.skips, []);
  });

  test("bot attached -> 200 (Meta must not redeliver), ZERO notes and ZERO contacts, skip recorded once per type, audited", async () => {
    const h = harness({ bot: "attached" });
    const r = await h.post(historyBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.code, "skipped_bot_attached");
    assert.equal((await h.post(stateBody())).status, 200);
    assert.deepEqual([h.notes.length, h.contacts.length, h.marked.size], [0, 0, 0]);
    assert.deepEqual(h.skips, [{ syncType: "history", status: "skipped_bot_attached" }, { syncType: "smb_app_state_sync", status: "skipped_bot_attached" }]);
    assert.ok(h.audits.includes("import_skipped_bot_attached"));
  });

  test("check fails or is ambiguous -> fail closed: 503, ZERO imports, nothing marked or recorded (Meta redelivers the same delivery)", async () => {
    for (const bot of ["fails", "ambiguous"] as const) {
      const h = harness({ bot });
      const r = await h.post(historyBody());
      assert.equal(r.status, 503, bot);
      assert.equal(r.body.code, "bot_check_failed");
      assert.deepEqual([h.notes.length, h.contacts.length, h.marked.size, h.skips.length], [0, 0, 0, 0]);
      assert.ok(h.audits.includes("import_bot_check_failed"));
    }
  });

  test("sticky: a type skipped earlier is never imported later, even with the bot gone (twin: the other type still imports)", async () => {
    const h = harness({ bot: "none", skippedPre: ["history"] });
    const r = await h.post(historyBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.code, "import_skipped_earlier");
    assert.equal(h.notes.length, 0);
    assert.deepEqual(h.botChecks, []); // nothing to import, so no check needed
    assert.equal((await h.post(stateBody())).status, 200);
    assert.equal(h.contacts.length, 2);
  });

  test("messages are still forwarded when a bot is attached (the guard covers imports only; Chatwoot stays the single processor)", async () => {
    const h = harness({ bot: "attached" });
    assert.equal((await h.post(msgBody())).status, 200);
    assert.equal(h.forwards.length, 1);
    assert.deepEqual(h.botChecks, []);
  });
});

describe("Codex fixes: Captain, mid-import attach, unrecorded skip, digest-first ordering", () => {
  const mixedBody = () => {
    const h = JSON.parse(historyBody()); const m = JSON.parse(msgBody());
    h.entry[0].changes.push(m.entry[0].changes[0]);
    return JSON.stringify(h);
  };

  test("a Captain assistant on the inbox -> nothing imported, skip recorded (twin: no AI -> imported, shown above)", async () => {
    const h = harness({ bot: "captain" });
    const r = await h.post(historyBody());
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.code, r.body.ai], ["skipped_bot_attached", "captain"]);
    assert.deepEqual([h.notes.length, h.contacts.length], [0, 0]);
    assert.deepEqual(h.skips, [{ syncType: "history", status: "skipped_bot_attached" }]);
  });

  test("an AI attached MID-import stops the remaining writes and records the skip (twin: no attach -> all 3 entries)", async () => {
    const h = harness({ botAfterChecks: 2 }); // check 1 (before the chunk) and 2 (thread 1) clear; check 3 (thread 2) finds a bot
    const r = await h.post(historyBody());
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.code, r.body.partial], ["skipped_bot_attached", true]);
    assert.equal(h.notes.length, 2); // thread 1 only; thread 2's entry was never written
    assert.equal(h.marked.size, 0); // the chunk is not marked imported
    assert.deepEqual(h.skips, [{ syncType: "history", status: "skipped_bot_attached" }]);
    const t = harness();
    await t.post(historyBody());
    assert.equal(t.notes.length, 3);
  });

  test("the AI check failing MID-import -> 503, remaining writes stopped, nothing marked or recorded (twin: no failure -> 3 entries, 200)", async () => {
    const h = harness({ failAfterChecks: 2 }); // checks 1-2 clear, check 3 (thread 2) fails
    const r = await h.post(historyBody());
    assert.deepEqual([r.status, r.body.code], [503, "bot_check_failed"]);
    assert.deepEqual([h.notes.length, h.marked.size, h.skips.length], [2, 0, 0]);
    const t = harness();
    assert.equal((await t.post(historyBody())).status, 200);
    assert.equal(t.notes.length, 3);
  });

  test("the sticky skip cannot be recorded -> 503 (Meta redelivers), NOT 200, nothing imported (twin: recorded -> 200)", async () => {
    const h = harness({ bot: "attached", recordSkipFails: true });
    const r = await h.post(historyBody());
    assert.deepEqual([r.status, r.body.code], [503, "skip_record_failed"]);
    assert.deepEqual([h.notes.length, h.contacts.length], [0, 0]);
    assert.ok(h.audits.includes("import_skip_record_failed"));
    const t = harness({ bot: "attached" });
    assert.equal((await t.post(historyBody())).status, 200);
  });

  test("digest FIRST: a delivery with history AND a message whose digest fails forwards NOTHING; the redelivery forwards exactly once", async () => {
    const h = harness({ chatwootFails: true });
    const raw = mixedBody();
    // the history thread fails at its first Chatwoot write; the message is not forwarded yet
    const r1 = await h.post(raw);
    assert.equal(r1.status, 500);
    assert.equal(h.forwards.length, 0);
    h.opts.chatwootFails = false; // Chatwoot recovers; Meta redelivers the SAME delivery
    const r2 = await h.post(raw);
    assert.equal(r2.status, 200);
    assert.equal(h.forwards.length, 1);
    assert.equal(h.forwards[0].raw, raw);
    // and a further redelivery of an imported chunk imports nothing new (the chunk is marked)
    const before = h.notes.length;
    await h.post(raw);
    assert.equal(h.notes.length, before);
  });

  test("an AI-check refusal (503) also forwards nothing, so the redelivery forwards once", async () => {
    const h = harness({ bot: "fails" });
    const raw = mixedBody();
    assert.equal((await h.post(raw)).status, 503);
    assert.equal(h.forwards.length, 0);
    h.opts.bot = "none";
    assert.equal((await h.post(raw)).status, 200);
    assert.equal(h.forwards.length, 1);
  });
});
