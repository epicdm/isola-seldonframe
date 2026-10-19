// ROUTE-LEVEL test of POST /api/phone-whatsapp/webhook/meta (the exported route handler itself, production wiring: real binding lookup
// in a scratch Postgres through the production driver, real Chatwoot client, real forwarder). The only seam is globalThis.fetch, which
// is spied: calls to the inbox webhook URL are FORWARDS, calls to the Chatwoot API base are IMPORTS; everything else (the database driver)
// passes through. Every refusal has its positive twin in the same run (Law 19).
//
// Opt-in, same guard as the other DB specs: refuses unless NEON_LOCAL_HOST is set AND PHONE_WHATSAPP_DB_TEST=scratch.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { before, describe } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.PHONE_WHATSAPP_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;
const ORG = "aaaaaaaa-0000-4000-8000-0000000000d4";
const PHONE = "900000000000042";
const SECRET = ["fixture", "route", "app", "secret"].join("-"); // fictional test value, not a credential
const FWD = "http://cw-inbox.test/webhooks/whatsapp/%2B15550142";
const API = "http://cw-api.test";

const body = (field: string, value: Record<string, unknown>) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "900000000000041", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550142", phone_number_id: PHONE }, ...value } }] }] });
const msg = () => body("messages", { messages: [{ from: "15550001", id: "wamid.r1", timestamp: "1792300000", type: "text", text: { body: "hi" } }] });
const hist = () => body("history", { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: "15550001", messages: [{ from: "15550001", id: "wamid.rh1", timestamp: "1780000000", type: "text", text: { body: "old" } }] }] }] });
const sign = (raw: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

describe("coexistence receiver route: signature is checked before any forward or import", { skip: !enabled && "set PHONE_WHATSAPP_DB_TEST=scratch with a scratch database" }, () => {
  let POST: (r: Request) => Promise<Response>;
  const forwards: string[] = [];
  const imports: string[] = [];
  let db: typeof import("@/db").db;

  before(async () => {
    process.env.META_APP_SECRET = SECRET;
    process.env.PHONE_COEX_CHATWOOT_API_BASE = API;
    process.env.PHONE_COEX_CHATWOOT_API_TOKEN = "fixture-cw-token";
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.startsWith("http://cw-inbox.test")) { forwards.push(u); return new Response("", { status: 200 }); }
      if (u.startsWith(API)) {
        imports.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
        const p = new URL(u).pathname;
        const json = p.endsWith("/captain/assistants") ? { payload: [] } : p.endsWith("/agent_bot") ? { agent_bot: {} } : p.endsWith("/contacts/search") ? { payload: [] } : p.endsWith("/contacts") ? { payload: { contact: { id: 5 } } } : p.endsWith("/conversations") && init?.method === "GET" ? { payload: [] } : p.endsWith("/conversations") ? { id: 9 } : p.includes("/contacts/5/conversations") ? { payload: [] } : { id: 1 };
        return new Response(JSON.stringify(json), { status: 200 });
      }
      return real(input as RequestInfo, init);
    }) as typeof fetch;
    ({ db } = await import("@/db"));
    await db.execute(sql`create table if not exists organizations (id uuid primary key, name text, slug text, settings jsonb, integrations jsonb)`);
    await db.execute(sql`delete from organizations where id = ${ORG}::uuid`);
    const settings = { phoneWhatsapp: { connections: { [PHONE]: { status: "connected_coexistence", mode: "coexistence", wabaId: "900000000000041", chatwoot: { accountId: "2", inboxId: 77, forwardUrl: FWD } } } } };
    await db.execute(sql`insert into organizations (id, name, slug, settings) values (${ORG}::uuid, 'ws-r', 'ws-r', ${JSON.stringify(settings)}::jsonb)`);
    ({ POST } = await import("@/app/api/phone-whatsapp/webhook/meta/route"));
  });

  const post = (raw: string, sig: string | null) =>
    POST(new Request("http://uplink.test/api/phone-whatsapp/webhook/meta", { method: "POST", body: raw, headers: { "content-type": "application/json", ...(sig === null ? {} : { "x-hub-signature-256": sig }) } }));
  const reset = () => { forwards.length = 0; imports.length = 0; };

  test("absent, malformed or wrong-secret signature: 401, ZERO forwards and ZERO imports (message and history payloads)", async () => {
    for (const raw of [msg(), hist()]) {
      for (const sig of [null, "", "sha256=00", "sha1=" + sign(raw).slice(7), sign(raw, "another-secret"), sign(raw + " ")]) {
        reset();
        const r = await post(raw, sig);
        assert.equal(r.status, 401, `sig=${String(sig).slice(0, 12)}`);
        assert.deepEqual([forwards.length, imports.length], [0, 0]);
      }
    }
  });

  test("positive control: a valid signature on a message is forwarded exactly once to the bound inbox, nothing imported", async () => {
    reset();
    const r = await post(msg(), sign(msg()));
    assert.equal(r.status, 200);
    assert.deepEqual(forwards, [FWD]);
    assert.equal(imports.length, 0);
  });

  test("positive control: a valid signature on history imports into Chatwoot (the import spy can see), nothing forwarded", async () => {
    reset();
    const r = await post(hist(), sign(hist()));
    assert.equal(r.status, 200);
    assert.equal(forwards.length, 0);
    assert.ok(imports.some((i) => i.endsWith("/conversations/9/messages")), imports.join(", "));
  });
});
