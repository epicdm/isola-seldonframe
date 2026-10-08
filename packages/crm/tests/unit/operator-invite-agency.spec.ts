// EPIC 2026-10-08 agency enablement: (1) workspace members may receive the operator sign-in link, (2) the platform-admin allowlist
// helper, (3) the operator sign-in email can be delivered through SMTP2GO. Every negative sits beside a positive control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmailAuthorizedForWorkspace, isEmailInAllowlist, parseAdminAllowlist } from "../../src/lib/operator-portal/authorization";
import { sendOperatorMagicLinkEmail } from "../../src/lib/emails/operator-magic-link";

const base = { ownerEmail: "agency@x.test", agencyOwnerEmail: "agency@x.test", adminEmails: [] as string[] };

test("an owner/admin member's email is authorised (positive control), a stranger's is not", () => {
  const s = { ...base, memberEmails: ["Customer@Biz.test "] };
  assert.equal(isEmailAuthorizedForWorkspace("customer@biz.test", s), true);
  assert.equal(isEmailAuthorizedForWorkspace("stranger@biz.test", s), false);
});

test("without memberEmails the customer is NOT authorised (proves the member list is what changes the answer)", () => {
  assert.equal(isEmailAuthorizedForWorkspace("customer@biz.test", base), false);
  assert.equal(isEmailAuthorizedForWorkspace("customer@biz.test", { ...base, memberEmails: [] }), false);
  assert.equal(isEmailAuthorizedForWorkspace("agency@x.test", base), true); // owner path unchanged
});

test("empty/blank email is never authorised even if the member list contains a blank", () => {
  assert.equal(isEmailAuthorizedForWorkspace("", { ...base, memberEmails: [""] }), false);
  assert.equal(isEmailAuthorizedForWorkspace(null, { ...base, memberEmails: [" "] }), false);
});

test("isEmailInAllowlist: matches case/whitespace-insensitively, empty never matches", () => {
  const list = parseAdminAllowlist(" Uplink@Epic.dm , other@x.test ");
  assert.equal(isEmailInAllowlist("uplink@epic.dm", list), true);
  assert.equal(isEmailInAllowlist("nobody@epic.dm", list), false);
  assert.equal(isEmailInAllowlist("", list), false);
  assert.equal(isEmailInAllowlist(null, list), false);
  assert.equal(isEmailInAllowlist("uplink@epic.dm", parseAdminAllowlist(undefined)), false);
});

const req = { email: "cust@biz.test", workspaceName: "Biz", inviteUrl: "https://uplink.epic.dm/portal/biz/magic?token=T", expiresInMinutes: 15 };

test("smtp2go transport: right endpoint, key in a header only, recipient and link in the body", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: { succeeded: 1, email_id: "m1" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendOperatorMagicLinkEmail(req, { apiKey: "KEY-123", fromAddress: "uplink@epic.dm", transport: "smtp2go", fetcher });
  assert.deepEqual(r, { ok: true, messageId: "m1" });
  assert.equal(seen!.url, "https://api.smtp2go.com/v3/email/send");
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers["X-Smtp2go-Api-Key"], "KEY-123");
  const body = String(seen!.init.body);
  assert.ok(!body.includes("KEY-123"), "api key must not be in the body");
  assert.ok(body.includes("cust@biz.test") && body.includes("/portal/biz/magic?token=T"));
});

test("smtp2go transport: a 200 with succeeded=0 is a FAILURE (not silently ok)", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ data: { succeeded: 0, error: "bad sender" } }), { status: 200 })) as unknown as typeof fetch;
  const r = await sendOperatorMagicLinkEmail(req, { apiKey: "K", fromAddress: "a@b.test", transport: "smtp2go", fetcher });
  assert.equal(r.ok, false);
});

test("default transport is still Resend (no behaviour change when transport is omitted)", async () => {
  let url = "";
  const fetcher = (async (u: string) => { url = u; return new Response(JSON.stringify({ id: "r1" }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await sendOperatorMagicLinkEmail(req, { apiKey: "K", fromAddress: "a@b.test", fetcher });
  assert.equal(url, "https://api.resend.com/emails");
  assert.deepEqual(r, { ok: true, messageId: "r1" });
});
