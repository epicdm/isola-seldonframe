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

// Real Chatwoot v4.18 shapes. app/views/api/v1/accounts/inboxes/agent_bot.json.jbuilder:1-3 renders
//   json.agent_bot do json.partial! 'api/v1/models/agent_bot', resource: @agent_bot if @agent_bot.present? end
// so an inbox with NO bot answers HTTP 200 with a bare {} (measured on live 4.18 and the scratch, 2026-10-19), and an inbox WITH a bot
// answers { agent_bot: <api/v1/models/_agent_bot.json.jbuilder> }. The earlier fixtures ({agent_bot:{}} / {agent_bot:null}) were never
// what 4.18 sends, which is how the 503 bot_check_failed on every no-bot inbox got past the suite.
const REAL_NO_BOT = {};
const REAL_BOT = {
  agent_bot: {
    id: 3, name: "Front desk", description: "", thumbnail: "", outgoing_url: "http://bot.test/hook", bot_type: "webhook",
    bot_config: {}, account_id: 2, access_token: FAKE, secret: FAKE, system_bot: false,
  },
};

describe("inboxBotAttached (GET /inboxes/:id/agent_bot, Chatwoot v4.18 shape)", () => {
  test("real 4.18 attached shape -> attached (the instrument CAN report a bot)", async () => {
    const { cw, seen } = client(() => ({ status: 200, json: REAL_BOT }));
    assert.equal(await cw.inboxBotAttached(77), true);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ["GET /api/v1/accounts/2/inboxes/77/agent_bot"]);
  });

  test("real 4.18 no-bot shape: a bare {} -> none", async () => {
    assert.equal(await client(() => ({ status: 200, json: REAL_NO_BOT })).cw.inboxBotAttached(77), false);
  });

  test("explicit empties are also none ({agent_bot:{}} and {agent_bot:null})", async () => {
    assert.equal(await client(() => ({ status: 200, json: { agent_bot: {} } })).cw.inboxBotAttached(77), false);
    assert.equal(await client(() => ({ status: 200, json: { agent_bot: null } })).cw.inboxBotAttached(77), false);
  });

  test("anything else is UNKNOWN and throws (callers fail closed): null body, array, malformed, HTTP error, bad inbox id", async () => {
    const cases: Array<{ status: number; json: unknown }> = [
      { status: 200, json: null },
      { status: 200, json: [] },
      { status: 200, json: [{ id: 3 }] },
      { status: 200, json: { agent_bot: "x" } },
      { status: 200, json: { foo: 1 } },
      { status: 200, json: { id: 1 } },
      { status: 200, json: { agent_bot: [] } },
      { status: 200, json: { agent_bot: { name: "no id" } } },
      { status: 500, json: {} },
      { status: 404, json: { error: "not found" } },
    ];
    for (const c of cases) await assert.rejects(client(() => c).cw.inboxBotAttached(77), JSON.stringify(c));
    await assert.rejects(client(() => ({ status: 200, json: REAL_NO_BOT })).cw.inboxBotAttached(0));
  });
});

describe("Chatwoot calls never follow a redirect (Codex re-review 3)", () => {
  test("every request asks fetch not to follow redirects", async () => {
    const inits: Array<RequestInit | undefined> = [];
    const cw = makeChatwootClient({
      base: "http://cw-api.test", accountId: "2", apiToken: ["fixture", "cw", "token"].join("-"), // fictional test value, not a credential
      fetch: async (_u, init) => { inits.push(init); return new Response(JSON.stringify(REAL_NO_BOT), { status: 200 }); },
    });
    assert.equal(await cw.inboxBotAttached(77), false); // twin: the same harness DOES read a direct 200 {} as no bot
    assert.equal(inits.length, 1);
    assert.equal(inits[0]?.redirect, "manual");
  });

  test("a 3xx, or a 200 {} that arrived via a redirect, is never read as 'no bot'", async () => {
    const redirect3xx = makeChatwootClient({ base: "http://cw-api.test", accountId: "2", apiToken: FAKE,
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://elsewhere.test/" } }) });
    await assert.rejects(redirect3xx.inboxBotAttached(77));
    const followed = makeChatwootClient({ base: "http://cw-api.test", accountId: "2", apiToken: FAKE,
      fetch: async () => { const r = new Response(JSON.stringify({}), { status: 200 }); Object.defineProperty(r, "redirected", { value: true }); return r; } });
    await assert.rejects(followed.inboxBotAttached(77));
  });
});

describe("Connect never attaches a bot to the inbox it creates", () => {
  test("ensureWhatsappInbox (create path) sends no agent-bot request and no agent_bot field (twin: the bot read IS visible to the same spy)", async () => {
    const { cw, seen } = client((path, method) => {
      if (path.endsWith("/inboxes") && method === "GET") return { status: 200, json: { payload: [] } };
      if (path.endsWith("/inboxes") && method === "POST") return { status: 200, json: { id: 91 } };
      if (path.endsWith("/agent_bot")) return { status: 200, json: REAL_NO_BOT };
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
    // Codex re-review: a malformed inbox entry, or a list shorter than its total_count, is never read as 'no Captain'
    await assert.rejects(client(replyWith({ payload: [{ id: 4 }] }, { 4: { payload: [{ id: 12 }, { name: "no id" }] } })).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: [{ id: 4 }], meta: { total_count: 2 } }, {})).cw.inboxCaptainAttached(77));
    await assert.rejects(client(replyWith({ payload: [{ id: 4 }] }, { 4: { payload: [{ id: 12 }], meta: { total_count: 3 } } })).cw.inboxCaptainAttached(77));
    // twin: a complete, well-formed list with matching total_count is read normally
    assert.equal(await client(replyWith({ payload: [{ id: 4 }], meta: { total_count: 1 } }, { 4: { payload: [{ id: 12 }], meta: { total_count: 1 } } })).cw.inboxCaptainAttached(77), false);
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
