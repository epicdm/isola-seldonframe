// The Chatwoot client's agent-bot read (the bot guard's instrument) and the promise that Connect never attaches a bot. Fictional values only.
// The instrument is fired both ways (Law 11/19): it reports a bot when one is attached and "none" only for Chatwoot's explicit empty shape.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { aiAttached, makeChatwootClient } from "../../../src/lib/phone-whatsapp/connect/chatwoot-client";

type Seen = { method: string; path: string; body: string };
const FAKE = ["fixture", "not", "read"].join("-"); // fictional test value, not a credential

function client(reply: (path: string, method: string) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const cw = makeChatwootClient({
    base: "http://cw-api.test",
    accountId: "2",
    apiToken: ["fixture", "cw", "token"].join("-"), // fictional test value, not a credential
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      seen.push({ method, path, body: typeof init?.body === "string" ? init.body : "" });
      const r = reply(path, method);
      return new Response(JSON.stringify(r.json), { status: r.status });
    },
  });
  return { cw, seen };
}

describe("inboxBotAttached (GET /inboxes/:id/agent_bot, Chatwoot v4.18 shape)", () => {
  test("a bot object with an id -> attached (the instrument CAN report a bot)", async () => {
    const { cw, seen } = client(() => ({ status: 200, json: { agent_bot: { id: 3, name: "Front desk", access_token: FAKE, secret: FAKE } } }));
    assert.equal(await cw.inboxBotAttached(77), true);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ["GET /api/v1/accounts/2/inboxes/77/agent_bot"]);
  });

  test("Chatwoot's explicit empty shapes -> none ({} and null)", async () => {
    assert.equal(await client(() => ({ status: 200, json: { agent_bot: {} } })).cw.inboxBotAttached(77), false);
    assert.equal(await client(() => ({ status: 200, json: { agent_bot: null } })).cw.inboxBotAttached(77), false);
  });

  test("anything else is UNKNOWN and throws (callers fail closed): HTTP error, missing key, non-object, object without an id, bad inbox id", async () => {
    const cases: Array<{ status: number; json: unknown }> = [
      { status: 500, json: {} },
      { status: 404, json: { error: "not found" } },
      { status: 200, json: { id: 1 } },
      { status: 200, json: { agent_bot: "yes" } },
      { status: 200, json: { agent_bot: [] } },
      { status: 200, json: { agent_bot: { name: "no id" } } },
    ];
    for (const c of cases) await assert.rejects(client(() => c).cw.inboxBotAttached(77), JSON.stringify(c));
    await assert.rejects(client(() => ({ status: 200, json: { agent_bot: {} } })).cw.inboxBotAttached(0));
  });
});

describe("Connect never attaches a bot to the inbox it creates", () => {
  test("ensureWhatsappInbox (create path) sends no agent-bot request and no agent_bot field (twin: the bot read IS visible to the same spy)", async () => {
    const { cw, seen } = client((path, method) => {
      if (path.endsWith("/inboxes") && method === "GET") return { status: 200, json: { payload: [] } };
      if (path.endsWith("/inboxes") && method === "POST") return { status: 200, json: { id: 91 } };
      if (path.endsWith("/agent_bot")) return { status: 200, json: { agent_bot: {} } };
      return { status: 404, json: {} };
    });
    const r = await cw.ensureWhatsappInbox({ name: "WhatsApp Test", phoneE164: "+15550100", phoneNumberId: "900000000000002", wabaId: "900000000000001", businessToken: FAKE });
    assert.deepEqual(r, { inboxId: 91, created: true });
    assert.equal(seen.length, 2);
    assert.equal(seen.some((s) => /agent_bot/.test(s.path) || /agent_bot/.test(s.body)), false);
    // positive twin: the spy sees an agent-bot request when one is made
    await cw.inboxBotAttached(91);
    assert.equal(seen.some((s) => /agent_bot/.test(s.path)), true);
  });
});

describe("inboxCaptainAttached (GET captain/assistants, then captain/assistants/:id/inboxes)", () => {
  const replyWith = (assistants: unknown, inboxes: Record<number, unknown>, status = 200) => (path: string) => {
    if (path.endsWith("/captain/assistants")) return { status, json: assistants };
    const m = path.match(/\/captain\/assistants\/(\d+)\/inboxes$/);
    if (m) return { status: 200, json: inboxes[Number(m[1])] ?? { payload: [] } };
    return { status: 404, json: {} };
  };

  test("an assistant linked to the inbox -> attached (the instrument CAN report Captain)", async () => {
    const { cw, seen } = client(replyWith({ payload: [{ id: 4 }, { id: 6 }], meta: {} }, { 4: { payload: [{ id: 12 }] }, 6: { payload: [{ id: 77 }] } }));
    assert.equal(await cw.inboxCaptainAttached(77), true);
    assert.deepEqual(seen.map((s) => s.path), ["/api/v1/accounts/2/captain/assistants", "/api/v1/accounts/2/captain/assistants/4/inboxes", "/api/v1/accounts/2/captain/assistants/6/inboxes"]);
  });

  test("no assistant, or assistants on other inboxes only -> none", async () => {
    assert.equal(await client(replyWith({ payload: [], meta: {} }, {})).cw.inboxCaptainAttached(77), false);
    assert.equal(await client(replyWith({ payload: [{ id: 4 }] }, { 4: { payload: [{ id: 12 }] } })).cw.inboxCaptainAttached(77), false);
  });

  test("anything else is UNKNOWN and throws: HTTP error, non-array, assistant without id, inboxes non-array, too many assistants", async () => {
    await assert.rejects(client(replyWith({ payload: [] }, {}, 500)).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: "x" }, {})).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: [{ name: "no id" }] }, {})).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: [{ id: 4 }] }, { 4: { payload: {} } })).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: Array.from({ length: 51 }, (_, i) => ({ id: i + 1 })) }, {})).cw.inboxCaptainAttached(77));
  });
});

describe("aiAttached: agent bot first, then Captain; a failure of either throws", () => {
  const port = (bot: boolean | "throw", captain: boolean | "throw") => ({
    async ensureWhatsappInbox() { throw new Error("unused"); },
    async ensureContact() { throw new Error("unused"); },
    async ensureConversation() { throw new Error("unused"); },
    async createNote() { throw new Error("unused"); },
    async inboxBotAttached() { if (bot === "throw") throw new Error("x"); return bot; },
    async inboxCaptainAttached() { if (captain === "throw") throw new Error("x"); return captain; },
  });
  test("bot -> agent_bot; captain -> captain; neither -> null; either check failing -> throws", async () => {
    assert.equal(await aiAttached(port(true, false), 77), "agent_bot");
    assert.equal(await aiAttached(port(false, true), 77), "captain");
    assert.equal(await aiAttached(port(false, false), 77), null);
    await assert.rejects(aiAttached(port("throw", false), 77));
    await assert.rejects(aiAttached(port(false, "throw"), 77));
  });
});

describe("history entries are written as ACTIVITY + private (never dispatched to agent bots or account webhooks)", () => {
  test("createNote posts message_type 'activity' with private: true (twin: never 'outgoing')", async () => {
    const { cw, seen } = client(() => ({ status: 200, json: { id: 1 } }));
    await cw.createNote({ conversationId: 9, content: "[history] hi", sourceId: "history:wamid.x" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/v1/accounts/2/conversations/9/messages");
    const body = JSON.parse(seen[0].body);
    assert.deepEqual([body.message_type, body.private, body.source_id], ["activity", true, "history:wamid.x"]);
    assert.notEqual(body.message_type, "outgoing");
  });
});
