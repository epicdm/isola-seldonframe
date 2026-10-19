// EPIC 2026-10-09 -- workspace email through the SMTP2GO transport (same selection rule as portal codes / sign-in).
// DI'd fetcher: nothing reaches the network. Each negative case has its positive twin in the same file.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { smtp2goProvider, smtp2goSender } from "@/lib/emails/providers/smtp2go";
import { EmailProviderSendError, type EmailSendRequest } from "@/lib/emails/providers/interface";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function makeFetcher(payload: unknown, ok = true, status = 200) {
  const calls: Captured[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return { ok, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const baseRequest = (fetcher: typeof fetch, extra: Partial<EmailSendRequest> = {}): EmailSendRequest => ({
  orgId: "org-1",
  from: "hello@seldonframe.local", // the unverified placeholder the old code used
  to: "visitor@example.com",
  subject: "Your booking is confirmed",
  html: "<p>ok</p>",
  text: "ok",
  fetcher,
  ...extra,
});

const saved = { key: process.env.SMTP2GO_API_KEY, from: process.env.PORTAL_EMAIL_FROM };
afterEach(() => {
  if (saved.key === undefined) delete process.env.SMTP2GO_API_KEY; else process.env.SMTP2GO_API_KEY = saved.key;
  if (saved.from === undefined) delete process.env.PORTAL_EMAIL_FROM; else process.env.PORTAL_EMAIL_FROM = saved.from;
});

describe("smtp2goProvider", () => {
  test("configured: posts the SMTP2GO wire shape with the verified sender, not request.from", async () => {
    process.env.SMTP2GO_API_KEY = "api-DUMMY";
    process.env.PORTAL_EMAIL_FROM = "Uplink <no-reply@verified.example>";
    assert.equal(await smtp2goProvider.isConfigured("org-1"), true);
    assert.equal(smtp2goSender(), "Uplink <no-reply@verified.example>");
    const { fetcher, calls } = makeFetcher({ data: { succeeded: 1, email_id: "email-abc" } });
    const result = await smtp2goProvider.send(baseRequest(fetcher));
    assert.deepEqual(result, { externalMessageId: "email-abc", provider: "smtp2go" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.smtp2go.com/v3/email/send");
    assert.equal(calls[0].headers["X-Smtp2go-Api-Key"], "api-DUMMY");
    assert.equal(calls[0].body.sender, "Uplink <no-reply@verified.example>");
    assert.deepEqual(calls[0].body.to, ["visitor@example.com"]);
    assert.equal(calls[0].body.html_body, "<p>ok</p>");
    assert.equal(calls[0].body.text_body, "ok");
    assert.equal("attachments" in calls[0].body, false, "no attachments key when none were passed");
  });

  test("attachments (the .ics invite) map to SMTP2GO fileblob/mimetype", async () => {
    process.env.SMTP2GO_API_KEY = "api-DUMMY";
    process.env.PORTAL_EMAIL_FROM = "no-reply@verified.example";
    const { fetcher, calls } = makeFetcher({ data: { succeeded: 1, email_id: "e1" } });
    await smtp2goProvider.send(
      baseRequest(fetcher, { attachments: [{ filename: "invite.ics", content: "QkVHSU4=", contentType: "text/calendar; method=REQUEST" }] }),
    );
    assert.deepEqual(calls[0].body.attachments, [
      { filename: "invite.ics", fileblob: "QkVHSU4=", mimetype: "text/calendar; method=REQUEST" },
    ]);
  });

  test("a 200 with succeeded=0 is a FAILURE (never-lies), carrying the provider's reason", async () => {
    process.env.SMTP2GO_API_KEY = "api-DUMMY";
    process.env.PORTAL_EMAIL_FROM = "no-reply@verified.example";
    const { fetcher } = makeFetcher({ data: { succeeded: 0, error: "Sender not verified" } });
    await assert.rejects(
      () => smtp2goProvider.send(baseRequest(fetcher)),
      (err: unknown) => err instanceof EmailProviderSendError && /Sender not verified/.test(err.message) && err.retriable === false,
    );
  });

  test("a 5xx is a retriable failure", async () => {
    process.env.SMTP2GO_API_KEY = "api-DUMMY";
    process.env.PORTAL_EMAIL_FROM = "no-reply@verified.example";
    const { fetcher } = makeFetcher({ data: {} }, false, 503);
    await assert.rejects(
      () => smtp2goProvider.send(baseRequest(fetcher)),
      (err: unknown) => err instanceof EmailProviderSendError && err.retriable === true,
    );
  });

  test("NEGATIVE: not configured (no key, or key without a sender) -> isConfigured false and send throws, no fetch", async () => {
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.PORTAL_EMAIL_FROM;
    assert.equal(await smtp2goProvider.isConfigured("org-1"), false);
    process.env.SMTP2GO_API_KEY = "api-DUMMY"; // key without a verified sender is NOT enough (same rule as the portal)
    assert.equal(await smtp2goProvider.isConfigured("org-1"), false);
    const { fetcher, calls } = makeFetcher({ data: { succeeded: 1 } });
    await assert.rejects(() => smtp2goProvider.send(baseRequest(fetcher)), EmailProviderSendError);
    assert.equal(calls.length, 0);
  });
});
