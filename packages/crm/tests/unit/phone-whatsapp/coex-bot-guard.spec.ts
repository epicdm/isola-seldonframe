// The Chatwoot client's agent-bot read (the bot guard's instrument) and the promise that Connect never attaches a bot. Fictional values only.
// The instrument is fired both ways (Law 11/19): it reports a bot when one is attached and "none" only for Chatwoot's explicit empty shape.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { makeChatwootClient } from "../../../src/lib/phone-whatsapp/connect/chatwoot-client";

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
