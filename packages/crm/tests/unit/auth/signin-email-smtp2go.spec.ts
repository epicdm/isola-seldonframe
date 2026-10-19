// Run: node --import tsx --test tests/unit/auth/signin-email-smtp2go.spec.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sendSignInEmailViaSmtp2go } from "../../../src/lib/auth/signin-email-smtp2go";

const msg = { to: "owner@example.test", subject: "s", html: "<a>x</a>", text: "x" };
const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe("sendSignInEmailViaSmtp2go", () => {
  test("positive control: success posts sender/to/key header and returns the message id", async () => {
    let seen: { url?: string; headers?: Record<string, string>; body?: any } = {};
    const fetcher = (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: { succeeded: 1, email_id: "m1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendSignInEmailViaSmtp2go(msg, { apiKey: "k", from: "EPIC <a@b.test>", fetcher });
    assert.equal(r.messageId, "m1");
    assert.equal(seen.url, "https://api.smtp2go.com/v3/email/send");
    assert.equal(seen.headers?.["X-Smtp2go-Api-Key"], "k");
    assert.deepEqual(seen.body.to, ["owner@example.test"]);
    assert.equal(seen.body.sender, "EPIC <a@b.test>");
  });
  test("HTTP 200 with succeeded=0 still throws (never claims delivery)", async () => {
    await assert.rejects(sendSignInEmailViaSmtp2go(msg, { apiKey: "k", from: "f", fetcher: ok({ data: { succeeded: 0, error: "bad sender" } }) as any }), /bad sender/);
  });
  test("non-2xx throws", async () => {
    await assert.rejects(sendSignInEmailViaSmtp2go(msg, { apiKey: "k", from: "f", fetcher: ok({}, 401) as any }), /SMTP2GO 401/);
  });
  test("network failure throws", async () => {
    const fetcher = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    await assert.rejects(sendSignInEmailViaSmtp2go(msg, { apiKey: "k", from: "f", fetcher }), /unreachable.*ECONNRESET/);
  });
});
