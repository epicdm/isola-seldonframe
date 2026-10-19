// account_update lifecycle, coexistence configuration (fail closed), the shared holding-status list (Law 21), and the Chatwoot client's
// request shapes. Fictional ids only; every refusal has a positive twin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { makeChatwootClient } from "../../../src/lib/phone-whatsapp/connect/chatwoot-client";
import { chatwootInboxWebhookUrl, loadCoexConfig } from "../../../src/lib/phone-whatsapp/connect/coexistence-config";
import { HOLDING_STATUSES } from "../../../src/lib/phone-whatsapp/connect/holding-statuses";
import { parseLifecycleEvent, planLifecycle, type LifecycleConn } from "../../../src/lib/phone-whatsapp/connect/lifecycle";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const WABA = "900000000000001";

describe("account_update lifecycle", () => {
  const conns: LifecycleConn[] = [
    { orgId: ORG, phoneNumberId: "900000000000002", status: "connected_coexistence", disconnectedFrom: null },
    { orgId: ORG, phoneNumberId: "900000000000003", status: "active", disconnectedFrom: null },
    { orgId: ORG, phoneNumberId: "900000000000004", status: "failed", disconnectedFrom: null },
  ];
  const ev = (event: string) => parseLifecycleEvent({ wabaId: WABA, event, reason: "ACCOUNT_DISCONNECTED", at: "2026-10-19T12:00:00Z" })!;
  test("PARTNER_REMOVED / ACCOUNT_OFFBOARDED disconnect connected numbers and remember what to restore; unfinished ones untouched", () => {
    for (const e of ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"]) {
      assert.deepEqual(planLifecycle(ev(e), conns).map((t) => [t.phoneNumberId, t.from, t.to, t.disconnectedFrom]), [
        ["900000000000002", "connected_coexistence", "disconnected", "connected_coexistence"],
        ["900000000000003", "active", "disconnected", "active"],
      ]);
    }
  });
  test("ACCOUNT_RECONNECTED restores only a disconnected number to its remembered status; repeats and other events change nothing", () => {
    const dis: LifecycleConn[] = [{ orgId: ORG, phoneNumberId: "900000000000002", status: "disconnected", disconnectedFrom: "connected_coexistence" }];
    assert.deepEqual(planLifecycle(ev("ACCOUNT_RECONNECTED"), dis).map((t) => [t.from, t.to]), [["disconnected", "connected_coexistence"]]);
    assert.deepEqual(planLifecycle(ev("PARTNER_REMOVED"), dis), []); // already disconnected: idempotent
    assert.deepEqual(planLifecycle(ev("ACCOUNT_RECONNECTED"), conns), []); // nothing disconnected
    assert.deepEqual(planLifecycle(ev("VERIFIED_ACCOUNT"), conns), []); // audit only
  });
  test("the forwarded body is validated (twin: a good one parses)", () => {
    for (const bad of [null, {}, { wabaId: "x", event: "E" }, { wabaId: WABA }, { wabaId: WABA, event: "x".repeat(101) }]) assert.equal(parseLifecycleEvent(bad), null);
    assert.equal(parseLifecycleEvent({ wabaId: WABA, event: "PARTNER_REMOVED" })?.event, "PARTNER_REMOVED");
  });
});

describe("coexistence configuration fails closed", () => {
  const full = {
    PHONE_COEX_RECEIVER_URL: "https://uplink.test/api/phone-whatsapp/webhook/meta",
    PHONE_COEX_RECEIVER_VERIFY_TOKEN: "verify-token-0123456789",
    PHONE_COEX_CHATWOOT_API_BASE: "https://chat.test/",
    PHONE_COEX_CHATWOOT_API_TOKEN: "fixture-cw-token",
    PHONE_COEX_CHATWOOT_ACCOUNTS: `${ORG}:2, bbbbbbbb-0000-4000-8000-000000000002:3`,
  };
  test("complete config for a mapped workspace is available (positive control); webhook base defaults to the API base", () => {
    const c = loadCoexConfig(ORG, full)!;
    assert.deepEqual([c.chatwootAccountId, c.chatwootApiBase, c.chatwootWebhookBase], ["2", "https://chat.test", "https://chat.test"]);
    assert.equal(chatwootInboxWebhookUrl(c.chatwootWebhookBase, "+15550100"), "https://chat.test/webhooks/whatsapp/%2B15550100");
  });
  test("any missing piece, an unmapped workspace, a short verify token or plain http (outside test mode) = unavailable", () => {
    for (const k of Object.keys(full)) assert.equal(loadCoexConfig(ORG, { ...full, [k]: "" }), null, k);
    assert.equal(loadCoexConfig("cccccccc-0000-4000-8000-000000000003", full), null);
    assert.equal(loadCoexConfig(ORG, { ...full, PHONE_COEX_RECEIVER_VERIFY_TOKEN: "short" }), null);
    assert.equal(loadCoexConfig(ORG, { ...full, PHONE_COEX_CHATWOOT_API_BASE: "http://chat.test" }), null);
    assert.notEqual(loadCoexConfig(ORG, { ...full, PHONE_COEX_CHATWOOT_API_BASE: "http://chat.test" }, true), null);
    assert.equal(loadCoexConfig(null, full), null);
  });
});

test("Law 21: both 'who holds this number' stores use the one shared status list, which includes the coexistence statuses", () => {
  const root = process.cwd();
  for (const f of ["src/lib/phone-whatsapp/connect/server-wiring.ts", "src/lib/phone-whatsapp/service/stores.ts"]) {
    const src = readFileSync(join(root, f), "utf8");
    assert.match(src, /HOLDING_STATUSES/, f);
    assert.doesNotMatch(src, /in \('pending','registering','registered','active'\)/, f); // the old inline copy is gone
  }
  for (const s of ["pending", "registering", "registered", "active", "coex_linking", "connected_coexistence", "disconnected"]) assert.ok((HOLDING_STATUSES as readonly string[]).includes(s), s);
  assert.equal((HOLDING_STATUSES as readonly string[]).includes("failed"), false); // a failed attempt releases the number
});

describe("Chatwoot client request shapes (Chatwoot v4.18 routes)", () => {
  function fake(responses: Record<string, unknown>) {
    const seen: Array<{ method: string; path: string; body: unknown; token: string | null }> = [];
    const f = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace("/api/v1/accounts/2", "") + u.search;
      const method = init?.method ?? "GET";
      seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined, token: (init?.headers as Record<string, string>)?.api_access_token ?? null });
      const key = `${method} ${path.split("?")[0]}`;
      return new Response(JSON.stringify(responses[key] ?? {}), { status: key in responses ? 200 : 404 });
    };
    return { seen, cw: makeChatwootClient({ base: "https://chat.test", accountId: "2", apiToken: "fixture-cw-token", fetch: f }) };
  }
  test("a new inbox is created as whatsapp_cloud with source manual_setup_v2 (Chatwoot then does NOT set its own webhook override)", async () => {
    const { seen, cw } = fake({ "GET /inboxes": { payload: [] }, "POST /inboxes": { id: 77 } });
    assert.deepEqual(await cw.ensureWhatsappInbox({ name: "WhatsApp Test", phoneE164: "+15550100", phoneNumberId: "900000000000002", wabaId: WABA, businessToken: "biz-token" }), { inboxId: 77, created: true });
    const create = seen.find((s) => s.method === "POST")!;
    assert.deepEqual((create.body as { channel: unknown }).channel, {
      type: "whatsapp", phone_number: "+15550100", provider: "whatsapp_cloud",
      provider_config: { api_key: "biz-token", phone_number_id: "900000000000002", business_account_id: WABA, source: "manual_setup_v2" },
    });
    assert.ok(seen.every((s) => s.token === "fixture-cw-token"));
  });
  test("an existing inbox for the number is reused (twin above creates); one bound to another Meta phone id is a conflict, never overwritten", async () => {
    const ok = fake({ "GET /inboxes": { payload: [{ id: 5, channel_type: "Channel::Whatsapp", phone_number: "+15550100", provider_config: { phone_number_id: "900000000000002" } }] } });
    assert.deepEqual(await ok.cw.ensureWhatsappInbox({ name: "x", phoneE164: "+15550100", phoneNumberId: "900000000000002", wabaId: WABA, businessToken: "t" }), { inboxId: 5, created: false });
    assert.equal(ok.seen.some((s) => s.method === "POST"), false);
    const bad = fake({ "GET /inboxes": { payload: [{ id: 5, channel_type: "Channel::Whatsapp", phone_number: "+15550100", provider_config: { phone_number_id: "900000000000999" } }] } });
    await assert.rejects(bad.cw.ensureWhatsappInbox({ name: "x", phoneE164: "+15550100", phoneNumberId: "900000000000002", wabaId: WABA, businessToken: "t" }), /409/);
  });
  test("history entries are ACTIVITY + private with a source id (never sent to WhatsApp, never dispatched to agent bots; Codex 2026-10-19)", async () => {
    const { seen, cw } = fake({ "POST /conversations/9/messages": { id: 1 } });
    await cw.createNote({ conversationId: 9, content: "x", sourceId: "history:wamid.1" });
    assert.deepEqual(seen[0].body, { content: "x", message_type: "activity", private: true, source_id: "history:wamid.1" });
  });
});
