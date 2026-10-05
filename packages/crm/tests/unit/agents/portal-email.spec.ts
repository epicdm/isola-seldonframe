// EPIC 2026-10-04 -- portal sign-in code email: Resend path unchanged, SMTP2GO path added (positive twins included).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { sendPortalAccessCodeEmail } from "../../../src/lib/emails/portal-access-code";
import { selectPortalEmailTransport } from "../../../src/lib/portal/email-transport";

const REQ = { email: "pat@example.invalid", workspaceName: "EPIC Communications", code: "123456", expiresInMinutes: 15 };

function fakeFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("sendPortalAccessCodeEmail transports", () => {
  test("default (resend) is unchanged: Resend endpoint, bearer header, resend payload", async () => {
    const { f, calls } = fakeFetch(200, { id: "re_1" });
    const res = await sendPortalAccessCodeEmail(REQ, { apiKey: "k", fromAddress: "EPIC <a@epic.example>", fetcher: f });
    assert.deepEqual(res, { ok: true, messageId: "re_1" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer k");
    assert.ok(JSON.parse(String(calls[0].init.body)).html);
  });
  test("smtp2go: its endpoint, key in a header (not in the body), its payload names, id returned", async () => {
    const { f, calls } = fakeFetch(200, { data: { succeeded: 1, email_id: "sm_1" } });
    const res = await sendPortalAccessCodeEmail(REQ, { apiKey: "secretkey", fromAddress: "EPIC <a@epic.example>", fetcher: f, transport: "smtp2go" });
    assert.deepEqual(res, { ok: true, messageId: "sm_1" });
    assert.equal(calls[0].url, "https://api.smtp2go.com/v3/email/send");
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Smtp2go-Api-Key"], "secretkey");
    const body = JSON.parse(String(calls[0].init.body));
    assert.ok(!JSON.stringify(body).includes("secretkey"), "key is not in the body");
    assert.deepEqual(body.to, ["pat@example.invalid"]);
    assert.equal(body.sender, "EPIC <a@epic.example>");
    assert.match(body.html_body, /123456/);
    assert.match(body.text_body, /123456/);
  });
  test("smtp2go: a 200 with succeeded 0, an HTTP error and a network failure are all reported as failures", async () => {
    const zero = fakeFetch(200, { data: { succeeded: 0, error: "sender not verified" } });
    const r0 = await sendPortalAccessCodeEmail(REQ, { apiKey: "k", fromAddress: "a", fetcher: zero.f, transport: "smtp2go" });
    assert.equal(r0.ok, false);
    assert.match((r0 as { error: string }).error, /sender not verified/);
    const http = fakeFetch(401, { data: { error: "bad key" } });
    const r1 = await sendPortalAccessCodeEmail(REQ, { apiKey: "k", fromAddress: "a", fetcher: http.f, transport: "smtp2go" });
    assert.deepEqual([r1.ok, (r1 as { status: number }).status], [false, 401]);
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r2 = await sendPortalAccessCodeEmail(REQ, { apiKey: "k", fromAddress: "a", fetcher: boom, transport: "smtp2go" });
    assert.deepEqual([r2.ok, (r2 as { status: number }).status], [false, 502]);
  });
});

describe("transport selection", () => {
  const SMTP = { SMTP2GO_API_KEY: "smtp-key", PORTAL_EMAIL_FROM: "EPIC <login@mail.example.test>" };
  test("SMTP2GO is selected when both its key and a sender are set", () => {
    assert.deepEqual(selectPortalEmailTransport(SMTP), { transport: "smtp2go", apiKey: "smtp-key", from: "EPIC <login@mail.example.test>" });
  });
  test("SMTP2GO still wins when a Resend key is ALSO set (an invalid Resend key must not take over)", () => {
    const sel = selectPortalEmailTransport({ ...SMTP, RESEND_API_KEY: "re_old_invalid", AUTH_RESEND_KEY: "re_other_invalid" });
    assert.equal(sel.transport, "smtp2go");
  });
  test("the live container shape (AUTH_RESEND_KEY only, no RESEND_API_KEY) plus SMTP2GO selects SMTP2GO; AUTH_RESEND_KEY alone selects nothing", () => {
    assert.equal(selectPortalEmailTransport({ ...SMTP, AUTH_RESEND_KEY: "re_x" }).transport, "smtp2go");
    assert.equal(selectPortalEmailTransport({ AUTH_RESEND_KEY: "re_x" }).transport, "none");
  });
  test("SMTP2GO key without a sender (or the reverse) is NOT selected; positive controls: Resend and none", () => {
    assert.equal(selectPortalEmailTransport({ SMTP2GO_API_KEY: "k" }).transport, "none");
    assert.equal(selectPortalEmailTransport({ PORTAL_EMAIL_FROM: "a@b.test" }).transport, "none");
    assert.equal(selectPortalEmailTransport({ SMTP2GO_API_KEY: "k", RESEND_API_KEY: "r" }).transport, "resend");
    assert.deepEqual(selectPortalEmailTransport({ RESEND_API_KEY: " r " }), { transport: "resend", apiKey: "r" });
    assert.deepEqual(selectPortalEmailTransport({}), { transport: "none" });
  });
});

describe("wiring: portal login action", () => {
  test("auth.ts takes its transport from the selector and no longer reads RESEND_API_KEY itself", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/lib/portal/auth.ts"), "utf8");
    assert.match(src, /selectPortalEmailTransport\(process\.env\)/);
    assert.match(src, /selected\.transport === "smtp2go" \? selected\.from : fromAddress/);
    assert.doesNotMatch(src, /process\.env\.RESEND_API_KEY/);
  });
});
