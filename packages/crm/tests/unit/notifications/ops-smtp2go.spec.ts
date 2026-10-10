// EPIC 2026-10-09 -- ops alerts (new lead, ...) go through SMTP2GO when configured, and AUTH_RESEND_KEY is no
// longer a delivery key. Measured defect: production logged ops_notification_failed 401 "API key is invalid"
// because the alert fell back to AUTH_RESEND_KEY and posted it to api.resend.com while SMTP2GO was configured.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sendNewLeadAlert } from "@/lib/notifications/ops-notifications";

function makeFetcher(payload: unknown = { data: { succeeded: 1, email_id: "e1" } }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return { ok: true, status: 200, json: async () => payload, text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const lead = { businessName: "Synthetic Demo HVAC Co", name: "Dana R.", phone: "+13055550100", need: "AC Repair", orgSlug: "synthetic-demo-hvac-co" };

describe("ops alerts via SMTP2GO", () => {
  test("SMTP2GO configured: the alert goes to api.smtp2go.com from PORTAL_EMAIL_FROM, to OPS_NOTIFICATION_EMAIL, not to Resend", async () => {
    const { fetcher, calls } = makeFetcher();
    await sendNewLeadAlert(lead, {
      fetcher,
      env: { SMTP2GO_API_KEY: "api-DUMMY", PORTAL_EMAIL_FROM: "no-reply@verified.example", OPS_NOTIFICATION_EMAIL: "ops@example.com", AUTH_RESEND_KEY: "re_stale" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.smtp2go.com/v3/email/send");
    assert.equal(calls[0].headers["X-Smtp2go-Api-Key"], "api-DUMMY");
    assert.equal(calls[0].body.sender, "no-reply@verified.example");
    assert.deepEqual(calls[0].body.to, ["ops@example.com"]);
    assert.match(String(calls[0].body.subject), /New lead/i);
  });

  test("NEGATIVE: only a stale AUTH_RESEND_KEY -> nothing is sent to Resend (the measured 401 path is gone)", async () => {
    const { fetcher, calls } = makeFetcher();
    await sendNewLeadAlert(lead, { fetcher, env: { AUTH_RESEND_KEY: "re_stale", OPS_NOTIFICATION_EMAIL: "ops@example.com" } });
    assert.equal(calls.length, 0);
  });

  test("POSITIVE TWIN: a real RESEND_API_KEY and no SMTP2GO -> still posts to Resend exactly as before", async () => {
    const { fetcher, calls } = makeFetcher();
    await sendNewLeadAlert(lead, { fetcher, env: { RESEND_API_KEY: "re_real", OPS_NOTIFICATION_EMAIL: "ops@example.com" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
  });

  test("SMTP2GO key without PORTAL_EMAIL_FROM is not enough (falls to the Resend rule, here: no key -> no send)", async () => {
    const { fetcher, calls } = makeFetcher();
    await sendNewLeadAlert(lead, { fetcher, env: { SMTP2GO_API_KEY: "api-DUMMY" } });
    assert.equal(calls.length, 0);
  });

  test("an SMTP2GO failure never throws (the alert must not break the booking/signup that triggered it)", async () => {
    const { fetcher } = makeFetcher({ data: { succeeded: 0, error: "Sender not verified" } });
    await assert.doesNotReject(() =>
      sendNewLeadAlert(lead, { fetcher, env: { SMTP2GO_API_KEY: "api-DUMMY", PORTAL_EMAIL_FROM: "no-reply@verified.example" } }),
    );
  });
});
